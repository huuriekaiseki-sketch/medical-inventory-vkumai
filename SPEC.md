# SPEC: 検証サブエージェントのエスケープハッチを人間専用に限定する(issue #348)

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

Stop hook(`verify-claims.sh`)が「未解消の指摘あり」として3回連続でブロックし続けた場合、現状は「誤検知なら `touch <パス>` でスキップできます」という案内をブロックされた本人(VS Code側のエージェント)自身に見せてしまっています。これだと、指摘を直す代わりに自分でそのファイルを作ってすり抜ける、という抜け道が成立してしまいます。

この修正後は:
- ブロックメッセージから具体的なコマンド案内を消し、「人間に相談してください」だけを表示するようにします。
- スキップ用ファイル(`.claude/.verify-state/<session_id>.skip`)を作成する行為そのものに、手段(touch・echo・python等)を問わず人間の確認プロンプトが挟まるようにします。エージェントが黙って作成しようとしても、人間が実際にその場で「はい」と答えない限り作成できません。
- 人間がその場で承認すれば、従来通りスキップは機能します。

### 操作の流れ

1. エージェントが同じ指摘で3回ブロックされる
2. stderrに「3回試みたが解消されなかった。人間に相談してください」とだけ表示される(具体的なコマンドは出ない)
3a. 人間が状況を見て誤検知と判断し、スキップ用ファイルの作成をエージェントに指示(またはエージェントが自発的に提案)した場合 → 作成しようとした瞬間に確認ダイアログが表示される → 人間が承認 → 次のStopで通過
3b. エージェントが人間に断りなく黙ってスキップ用ファイルを作成しようとした場合 → 同じ確認ダイアログが表示される(見えている画面の前に人間がいなければ、ここで待機したまま先に進まない)

📸 スクリーンショット対象外(CLIのStop hook・権限ダイアログのため通常の画面キャプチャ対象ではありません)

### 受け入れ条件

- [ ] ブロックメッセージに具体的なコマンド(ファイルパスの作り方)が含まれない
- [ ] `touch`・`echo`・`python3`・`node`など手段を問わず、`.claude/.verify-state/*.skip`への書き込みを試みると人間の確認プロンプトが表示される
- [ ] 確認プロンプトで人間が承認した場合のみスキップが機能する(黙って通過することはない)
- [ ] 既存のテスト(3回超過後のブロック継続、.skip使用時のpass、.skip消費後の状態リセット)が引き続き通る
- [ ] 設計ドキュメント(`docs/superpowers/specs/2026-07-14-verification-subagent-design.md`)のエスケープハッチ節・ブロックロジック節・エラーハンドリング表が新しい挙動に更新されている

### 設計上の限界(正直な注意点)

- コマンド文字列に直接パスを書かず、変数展開・base64エンコード等で難読化された場合は正規表現マッチをすり抜けうる。完全な保証ではなく、典型的な迂回手段(touch/echo/cp/python -c/node -e等)を塞ぐもの
- 確認プロンプトはVS Code側セッションを実際に見ている人間が応答することが前提。誰も見ていない完全放置の自律実行中は、確認待ちのまま止まる(=通過しない側に倒れる。これはブロック継続と同じ安全側の挙動)

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 実装セット(単一セット、依存関係があるため並列化しない)

対象ファイル:
- `scripts/verify-claims.sh`
- `scripts/verify-claims.test.sh`
- `docs/superpowers/specs/2026-07-14-verification-subagent-design.md`

いずれも同じロジック変更に対する実装/テスト/ドキュメントの三点セットであり、共有ファイルというより「1つの変更を3ファイルに反映する」性質のため、統合ゲート無しの単一実装セットとして扱う。

### 変更内容

#### 1. `scripts/verify-claims.sh`

**a. ブロックメッセージから具体案内を削除(86行目)**

現状:
```bash
emit_block "$(printf 'verify-claims: %d回の自動修正を試みましたが指摘が解消されませんでした。人間の介入待ちです。誤検知の場合は `touch %s` でスキップできます。\n%s' "$MAX_RETRIES" "$SKIP_MARKER" "$findings_msg")"
```

変更後: `touch %s` 部分を削除し、「人間に相談してください」のみにする。`SKIP_MARKER`変数自体は変更不要(既存のまま維持)。

**この修正のみで、`.skip`検知・pass判定ロジック(既存106-115行目)自体は一切変更しない。** エスケープハッチの安全性は後述のPreToolUse hookで「作成行為そのもの」をゲートする方式に一本化するため、Stop hook側に検知ロジックを持たせる必要がなくなる。

#### 2. 新規: `scripts/check-skip-marker-write.sh` (PreToolUse hook)

`.claude/.verify-state/<session_id>.skip`というパスへの書き込みを試みるツール呼び出し(Bash/Write/Edit)を検知し、手段を問わず人間の確認プロンプト(ask)に強制的に切り替える。

- 標準入力でPreToolUseのhook入力JSON(`tool_name`, `tool_input`)を受け取る
- `tool_name`が`Bash`の場合は`tool_input.command`全体(リダイレクト先パスを含む)、`Write`/`Edit`の場合は`tool_input.file_path`を対象に、正規表現 `\.claude/\.verify-state/[^/]+\.skip` にマッチするかを調べる
- マッチした場合、以下を標準出力してexit 0:
  ```json
  {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "verify-claimsのエスケープハッチ(.skipマーカー)への書き込みです。人間の確認が必要です。"}}
  ```
- マッチしない場合は何も出力せずexit 0(通常の許可フローに委ねる。allowでもdenyでもなく無関与)

判定基準:

| ケース | 挙動 |
|---|---|
| Bashコマンド文字列またはWrite/Edit file_pathが`.claude/.verify-state/*.skip`にマッチしない | このhookは関与しない(通常の権限フローのまま) |
| マッチする | `permissionDecision: "ask"`を返し、通常の確認ダイアログが表示される。人間が承認すれば実行され、拒否すれば実行されない |

既知の限界(設計ドキュメントに明記する):
- 正規表現によるコマンド文字列マッチのため、変数展開・base64エンコード等で意図的に難読化されたコマンドは検知をすり抜けうる。典型的な手段(touch/echo/cp/mv/python -c/node -e等、コマンド文字列に直接パスが現れるもの)を塞ぐのが目的であり、完全な保証ではない
- 確認プロンプトはVS Code側で実際にセッションを見ている人間が応答することが前提。誰も見ていない間は応答待ちのまま進まない(=通過しない側に倒れるため安全)

#### 3. `.claude/settings.json`

`PreToolUse` hookエントリを新規追加する:
```json
"PreToolUse": [
  {
    "matcher": "Bash|Write|Edit",
    "hooks": [
      { "type": "command", "command": "scripts/check-skip-marker-write.sh", "timeout": 5 }
    ]
  }
]
```
既存の`Stop`フックエントリ(doc-suggest-check.sh / ai-check-suggest.sh / verify-claims.sh)はそのまま変更しない。

#### 4. `scripts/verify-claims.sh`のテスト、`scripts/verify-claims.test.sh`

- 既存シナリオ5(「touch」「s5.skip」を含むことをアサート)は、コマンド案内を消す変更と矛盾するため、アサーション内容を「`touch`という語を含まないこと」「`人間に相談`という文言を含むこと」に更新する
- 既存シナリオ6・11(`.skip`マーカーでpass、消費後のリセット)は無変更で維持する(Stop hook側のロジックは変えていないため)

#### 5. 新規: `scripts/check-skip-marker-write.test.sh`

PreToolUse hook単体の回帰テスト。合成した`tool_name`/`tool_input`のJSONを標準入力で渡し、以下を確認する:
- シナリオ1: `Bash`で`command`が`touch .claude/.verify-state/abc.skip`の場合 → `permissionDecision: "ask"`が返る
- シナリオ2: `Bash`で`command`が`echo x > .claude/.verify-state/abc.skip`の場合(リダイレクト経由) → `permissionDecision: "ask"`が返る
- シナリオ3: `Write`で`file_path`が`.claude/.verify-state/abc.skip`の場合 → `permissionDecision: "ask"`が返る
- シナリオ4: `Bash`で`command`が`.claude/.verify-state/`と無関係な通常コマンド(例: `npm test`)の場合 → 何も出力されない(exit 0、空出力)
- シナリオ5: `Bash`で`command`が`.claude/.verify-state/`配下だが`.skip`拡張子ではないファイル(例: `cat .claude/.verify-state/abc.json`)への操作の場合 → 何も出力されない(状態ファイル自体の閲覧・既存ロジックの正常動作を妨げない)

#### 6. 設計ドキュメント更新

`docs/superpowers/specs/2026-07-14-verification-subagent-design.md`の以下を更新:
- 「エスケープハッチ(誤検知対策)」節(115-120行目): 「VS Code側セッションに依頼してtouchする形でも可」という記述を削除し、PreToolUse hookによるask強制の仕組みに差し替える
- 「判定・ブロックロジック」節(108-109行目): ブロックメッセージからコマンド案内を削除する旨を反映
- 「エラーハンドリングまとめ」表(143-153行目): `.skip`マーカーの行はStop hook側の挙動として変更なし(pass)のまま維持しつつ、「ただしマーカー作成自体はPreToolUse hookでask」の注記を追加
- テスト方針の一覧(225-243行目)にシナリオ5のアサーション更新内容と、新規`check-skip-marker-write.test.sh`への参照を追記

### 型・データアクセス層の方針

該当なし(bashスクリプトとMarkdownドキュメントのみの変更。DB/型定義/UIへの変更なし)。

---

## Part 3 — 仕様レビュー前セルフチェック（AI用・レビュー不要）

- **判定基準の欠落**: PreToolUse hookの判定は「`.claude/.verify-state/*.skip`にマッチする/しない」の2値のみであり、それぞれの挙動をPart2の表に明記済み。`permissionDecision`という既存のClaude Code側enum(allow/deny/ask)の値をそのまま使い、新しいstatusフィールドは追加していない。
- **下流の反応の欠落**: マッチしない場合はhookが完全に無関与(通常の権限フローに委ねる)、マッチする場合はask確認ダイアログが表示される。いずれの場合もStop hook(`verify-claims.sh`)側の`.skip`検知・pass判定ロジックには一切手を入れないため、既存の分岐(ケース1/2、fail-open、evidence検証等)への影響はない。
- **列挙の自己矛盾**: 対象/対象外のような包含・除外リストは今回無し(該当なし)。
- **信号の意味変更**: 既存の`permissionDecision`(Claude Code組み込みの権限判定シグナル)の意味は変えていない。今回はこのシグナルを新しい判定元(PreToolUse hookスクリプト)から発行するだけであり、下流(Claude Code本体の権限ダイアログ表示ロジック)が受け取る値の意味は従来通り。
