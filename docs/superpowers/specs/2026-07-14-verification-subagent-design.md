# 検証サブエージェント(Stop hook自動裏取り) 設計

## 背景・目的

2026-07-11、issue #41/#42/#165のレビューで、CLIセッション(Claude Code CLI)が担っていた「主張の裏取り役」(行番号・既存コード挙動・環境変数名の一致等をgrepで確認する)を、VS Code側セッション内に自動組み込みする方針で合意した([[project_verification_subagent]])。

VS Code側で実装 → スクリーンショットをCLIセッションに貼って質問 → CLI側がgrepで裏取りして指摘 → VS Code側で修正、という往復を人間が手動で仲介する煩雑さを無くすことが目的。無くすべきは「人間が2セッション間を手動で仲介する部分」であり、検証プロセス自体ではない。

対象は `medical-inventory-vkumai` リポジトリ(VS Code側のセッション)。CLIセッションはアドバイスのみに徹する方針([[feedback_cli_advisory_only]])のため、この検証サブエージェントもVS Code側での自動実行が前提。

## アーキテクチャ

### 発火の仕組み

- Stop hookとして `scripts/verify-claims.sh` を追加する(既存の `scripts/doc-suggest-check.sh` と並走)
- hookのJSON入力から `session_id` を取得する(既存の `doc-suggest-check.sh` と同じ形式)
- `git diff HEAD` + `git status --porcelain` + untrackedファイル(`git ls-files --others --exclude-standard`)の中身を連結した内容のSHA256ハッシュを「現在のdiffハッシュ」として計算する(既存パターンを流用)
  - **注意(issue #352)**: `git diff HEAD` はtrackedファイルの差分のみを含み、`git status --porcelain`はuntrackedファイルを `?? path` の1行としか出さず中身を含まない。そのため新規(untracked)ファイルの中身だけを直して再Stopしてもハッシュが変わらず、「何も直していない」ケース(上記スキップ・再判定ロジックの2)と誤判定されブロックが継続してしまう。これを防ぐため、`git ls-files --others --exclude-standard -z` で列挙したuntrackedファイルの中身(ファイル名込み)も直接読んでハッシュ対象に含める。`git add -N`等でindexを書き換える方式は採らない(このスクリプトがリポジトリ状態を副作用的に変えないようにするため)
  - この方式により、既存の別Stop hook(`claude_stop_notify.sh`の`git add -A`)が先に走って untracked ファイルを tracked 化してくれることへの暗黙の依存が無くなる。`verify-claims.sh`単独でuntrackedファイルの中身を検知できるため、hookの実行順序に依存しない
- 状態は `.claude/.verify-state/<session_id>.json` に保存する:
  ```json
  { "last_diff_hash": "...", "last_verdict": "pass" | "blocked", "retry_count": 0, "last_findings_message": "...", "last_blocking_fingerprint": "..." }
  ```
  `last_findings_message` は、ケース2(ハッシュ一致・前回blocked)で前回の指摘内容をLLM呼び出し
  無しに再提示するために保持する(実装: `scripts/verify-claims.sh`の`write_state`/`block_with_retry_check`)。
  `last_blocking_fingerprint` は、指摘の同一性判定(issue #351、下記「判定・ブロックロジック」節)
  に使う
- 7日より古い状態ファイルは `doc-suggest-check.sh` と同様に自動削除する

### スキップ・再判定ロジック

現在のdiffハッシュと `last_diff_hash` を比較する:

1. **ハッシュ一致 かつ `last_verdict == "pass"`**: 何も変わっていないので検証をスキップし、即 `exit 0`
2. **ハッシュ一致 かつ `last_verdict == "blocked"`**: 前回指摘した内容が解消されないまま再度Stopしようとしている。LLM呼び出しはせず、`retry_count` を+1し、前回と同じ指摘内容で再度 `exit 2`(ブロック継続)。retry_countが上限を超えたら「ブロックしたまま人間の介入待ち」に遷移する(下記参照)
3. **ハッシュ不一致**: 差分が変化しているので検証を実行する(下記)

(2)は、「何も直さずにもう一度Stopしようとする」行為自体にリトライ予算を消費させるための設計。これがないと、コストゼロのまま無限に足踏みしてリトライ回数が進まない。

### 検証本体

- `claude -p --model claude-haiku-4-5-20251001` をサブプロセスとして起動する(低コストモデル)
- ツールは読み取り専用(Read/Grep相当)のみ許可する。Edit/Write/副作用のあるBashは許可しない(検証のはずが勝手にコードを書き換えるリスクを防ぐため)
- タイムアウトは60秒とする(Haikuモデル・読み取り専用ツールのみの軽量な検証のため、通常はこれで十分。超過した場合は「インフラ障害時の扱い」節のfail-openとして扱う)
- **`--setting-sources ""` と `--no-session-persistence` を必須で付ける。** これが無いと、このサブプロセス自身がStopイベントでStop hook一式(このverify-claims.sh自身やグローバルの通知hook等)を継承・再発火させ、子プロセスが際限なく増殖する(詳細・実際の発生経緯は「運用インシデント」節を参照)。この制約はverify-claims.shに限らず、**hookから`claude -p`を起動するあらゆる箇所に適用される一般則**であり、[`known-failure-patterns.md`](../../agents/known-failure-patterns.md)にも相互参照を残している
- 渡す入力:
  - `transcript_path` から直前の assistant ターンの抜粋(発言・編集内容の要約。トランスクリプト全体は渡さない。大きすぎるとコスト・コンテキストの両面で問題になる)
  - 現在のdiff内容
- **検証対象とする主張の型(issue #353)**: この仕組みの価値の核心は「主張の裏取り」であり、一般的な
  コードレビューではない。ここが曖昧だと既存のreviewer/code-reviewと重複した劣化版になるため、
  対象とする主張を以下の3種類に明示的に限定する:
  1. 参照関係の主張: 「XはYを参照している/呼んでいる」「XはYに依存している」
  2. 既存コードの挙動に関する主張: 「この関数は既にZを処理している/ハンドリングしている」
     「〜という分岐が既に存在する」
  3. 識別子・位置の一致に関する主張: 行番号・環境変数名・関数名・ファイルパス等が実コードと
     一致しているか
  - **evidence(file:line等)必須**: 根拠箇所を示せない指摘(=検証しようがない曖昧な懸念)は
    findingsに含めないようプロンプトで明示する
  - **対象外(役割分担)**: 設計の良し悪し・命名規約・可読性・ベストプラクティス等の一般的な
    コードレビュー的指摘、および発言中で述べられていない検証エージェント自身の新規の気付きは
    findingsに含めない。これらは既存reviewer/code-reviewの担当とする
  - 実装: `scripts/verify-claims.sh` の `PROMPT` 変数
- 出力は以下のJSON形式を強制する:
  ```json
  { "findings": [ { "severity": "critical" | "important" | "minor", "description": "...", "evidence": "file:line等" } ] }
  ```
- **deny-by-default**: `severity` が欠損・不明な値の場合は `critical` として扱う(既存のAIDD Draft phaseと同じfail-open防止の方針。PR #298を踏襲)

### 証拠検証(Evidence Verification)(issue #354)

severity欠損時のdeny-by-defaultとは別に、findingsの`evidence`(file:line)自体が実在するかを
hook側で機械チェックする。検証サブエージェント自身がLLMである以上、`evidence`がハルシネーション
で実在しない箇所を指す可能性があり、それを無検証のままcritical/importantとして扱うと
「裏取り装置が裏取りされていない」構造になる(docs/agents/known-failure-patterns.md参照)。

- `evidence`文字列から拡張子付きのファイルパストークン(+ 任意の`:行番号`)を正規表現でベスト
  エフォート抽出する。拡張子の無いパス表記(例: `scripts/lib/foo`)は検知できない既知の限界がある
- 抽出したファイルがリポジトリ内に実在しない場合、または行番号がそのファイルの行数を超える場合は
  「evidence未検証」とみなす
- **evidence未検証のfindingはseverityを`minor`へ格下げする。** 完全に握りつぶす(無視する)選択肢
  もあったが、以下の理由で「格下げ+可視化」を採用した:
  - 完全に無視すると、findingが消えた理由が人間から見えなくなる。これはこのリポジトリの
    「no silent caps」原則(検知結果を機械的に見える形で残す)と矛盾する
  - `minor`はブロックしない(既存の判定ロジック通り)ため、ハルシネーションされたevidenceで
    Stopがブロックされ続ける事態(issue #348のエスケープハッチ問題と同種の被害)は防げる
  - 格下げ後もdescriptionに「evidence未検証」の注記が付き、`minor`一覧としてsystemMessageに
    表示され続けるため、誤検知が多発していることには気づける(issue #355の効果測定と接続する)
- **fail-open(exit 0での即時通過)ではなくseverity格下げを選んだ理由**: fail-openは「検証プロセス
  自体が動かなかった」(インフラ障害・タイムアウト等)場合に予約している区分であり、「検証は正常に
  動いたがevidenceの中身が怪しい」場合はこれと性質が異なる。前者と混同すると、fail-openの発生率が
  「検証エージェントが落ちている率」を表さなくなり、issue #355の効果測定の意味が薄れる

### 判定・ブロックロジック

- findings中の最大severityを求める
- **critical/important が1件以上ある場合**:
  - **retry_countの加算/リセット判定(issue #351)**: diffハッシュ不一致で再検証した場合、今回の
    critical/important findingsの`{severity, description, evidence}`をソートしてハッシュ化した
    「フィンガープリント」を、前回blocked時のフィンガープリント(`last_blocking_fingerprint`、
    状態ファイルに保存)と比較する
    - **前回`blocked`かつフィンガープリントが一致**(=同一の指摘が解消されないまま別の箇所を
      触ってdiffハッシュだけ変えた): `retry_count` を+1(累積)
    - **それ以外**(前回`pass`だった/前回`blocked`だが指摘の中身が変わった=別の新しい指摘):
      `retry_count` を1にリセット。長いセッションで散発的に別々の正当な指摘が出ただけで
      上限に達し人間介入待ちになることを防ぐ。なお「ハッシュ一致・前回blocked」の場合
      (スキップ・再判定ロジックの(2)、LLM呼び出し無し)は前回と同一のフィンガープリントを
      そのまま引き継ぐため、常に累積される(この経路の挙動は変えない)
  - `retry_count <= 3`(既存の `MAX_REVIEW_RETRIES` と同じ上限): 該当箇所の指摘内容を `stderr` に出力して `exit 2`(Stopをブロックし、VS Code側セッションに指摘を伝えて修正を促す)
  - `retry_count > 3`: ブロックしたまま人間の介入を待つ状態にする。`stderr` に「3回自動修正を試みたが解消されなかった」旨と「人間に相談してください」とだけ表示する。**issue #348以降、具体的なコマンド案内(`touch <パス>`等)はブロックメッセージから削除した。** これは、指摘を直す代わりにブロックされた本人(エージェント自身)がその案内通りにスキップ用ファイルを作成してすり抜けられてしまう抜け道だったため。エスケープハッチ自体の使い方は下記「エスケープハッチ(誤検知対策)」節を参照
  - 状態ファイルを `{ diff_hash, verdict: "blocked", retry_count, last_blocking_fingerprint }` で更新
- **findingsが無い、またはminorのみの場合**:
  - `exit 0`。minor findingsがあれば `systemMessage` として警告のみ添える(ブロックはしない)
  - `retry_count` を0にリセットし、状態ファイルを `{ diff_hash, verdict: "pass", retry_count: 0, last_blocking_fingerprint: "" }` で更新

### エスケープハッチ(誤検知対策)

検証サブエージェント自身がLLMである以上、誤って `critical` と判定する可能性がある。3回のリトライを使い切って完全ブロックされた場合に人間が詰まないよう、以下を用意する:

- 人間が `.claude/.verify-state/<session_id>.skip` というマーカーファイルを作成できるようにする
- hookはこのファイルの存在を検知したら、それを消費(削除)した上で無条件に `exit 0` とする。ログに「手動オーバーライドが使用された」旨を残す(このpass判定ロジック自体はissue #348の変更でも一切変えていない)

**issue #348: マーカー作成行為そのものを人間確認(ask)で強制する。** 当初の設計では「VS Code側セッションに依頼してtouchする形でも可」としていたが、これだとブロックされた本人(エージェント自身)が人間に断りなく黙ってスキップ用ファイルを作成し、指摘を直さずすり抜けられてしまう抜け道になっていた。これを塞ぐため、PreToolUse hook `scripts/check-skip-marker-write.sh` を追加した:

- `tool_name`が`Bash`の場合は`tool_input.command`全体(リダイレクト先パスを含む)、`Write`/`Edit`の場合は`tool_input.file_path`を対象に、正規表現 `\.claude/\.verify-state/[^/]+\.skip` にマッチするかを調べる
- マッチした場合、`permissionDecision: "ask"` を返す(`hookSpecificOutput.hookEventName: "PreToolUse"`)。これにより、touch・echo・python等の手段を問わず、`.skip`ファイルへの書き込みを試みた瞬間に通常の権限確認ダイアログが表示される。人間がその場で承認しない限り作成されない
- マッチしない場合は何も出力せずexit 0(allow/denyには関与せず、通常の権限フローに委ねる)
- `.claude/settings.json`の`hooks.PreToolUse`に`matcher: "Bash|Write|Edit"`で登録している。**この`matcher`はツール名の完全一致(exact match)のリストであり、`"MultiEdit"`のような別名ツールには一致しない。**将来Claude Code側に別名の書き込み系ツールが追加された場合は、`matcher`と`scripts/check-skip-marker-write.sh`内の`case`文の両方を更新する必要がある(片方だけ直しても検知が効かない)
- **cwd変更後の相対パス操作への対策(issue #348追加修正)**: 当初の実装は正規表現によるコマンド文字列の直接一致のみだったため、`cd .claude/.verify-state && touch abc.skip`という単一コマンド、または事前に`cd .claude/.verify-state`を実行済みの状態で別のBash呼び出しとして`touch abc.skip`のみを実行する、という**難読化ですらない通常の操作**で検知をすり抜けられることが4観点レビューで実証された。これに対し、(1)コマンド文字列中に`.claude/.verify-state`というディレクトリ参照と相対パスの`.skip`トークンの両方が含まれる場合、(2)hook入力の`cwd`フィールド(セッション間で持続する現在の作業ディレクトリ)が`.claude/.verify-state`配下を指しており、かつ対象文字列に相対パスの`.skip`トークンが含まれる場合、の2つを追加で検知するようにした

**実機検証で確認した安全側への倒れ方**: `--permission-mode bypassPermissions`かつheadlessモード(人間が確認に応答できない自律実行環境)で実際に検証したところ、hookが返す`permissionDecision: "ask"`は無視されず、確認相手が存在しない場合はツール実行が拒否される側に倒れることを確認済み。つまり「誰も見ていない完全放置の自律実行中に黙って`.skip`が作成されてしまう」ケースは発生しない(応答待ちのまま進まない=ブロック継続と同じ安全側の挙動)。**この検証は本実装時点のセッション内で一度実施したものであり、自動回帰テストとしては存在しない。**再現可能な形でリポジトリに残っているのは正規表現マッチ部分の`scripts/check-skip-marker-write.test.sh`のみで、`bypassPermissions`環境での実際のask強制の挙動そのものは手動一回検証にとどまる。

既知の限界:
- 正規表現によるコマンド文字列マッチのため、変数展開・base64エンコード等で意図的に難読化されたコマンドは検知をすり抜けうる。典型的な手段(touch/echo/cp/mv/python -c/node -e等、コマンド文字列に直接パスが現れるもの)を塞ぐのが目的であり、完全な保証ではない

### インフラ障害時の扱い(fail-open例外)

`claude -p` サブプロセス自体が失敗(タイムアウト・認証エラー・ネットワークエラー等)した場合、および `claude -p` は正常終了したが出力がfindingsのJSON形式として解析できなかった場合は、内容判断の deny-by-default とは別扱いにする。**この場合はfail-open(警告のみでexit 0)とする**。

理由: 「severityが不明」は検証した上での判断の曖昧さだが、「検証エージェントが動かなかった」のはツール自体の不備であり、これを理由にブロックし続けるのは開発を止めるだけで安全性に寄与しない。`systemMessage` に「検証エージェントの実行に失敗したため今回はスキップしました」と明記し、可視化はする。

## データフロー(概要)

```
Stop event
  → hookがsession_id取得、diffハッシュ計算
  → 状態ファイルと比較
      ├─ 一致 & pass → exit 0
      ├─ 一致 & blocked → retry_count+1、前回findingsで再ブロック判定
      └─ 不一致 → claude -p (Haiku, 読み取り専用) 実行
                     → findings取得、最大severity判定
                     → ブロック判定 or pass判定
  → 状態ファイル更新
  → exit code / systemMessage 出力
```

## エラーハンドリングまとめ

| ケース | 挙動 |
|---|---|
| severity欠損・不明 | critical扱い(deny-by-default) |
| evidenceが実在しない/行番号が範囲外(issue #354) | minorへ格下げ(ブロックしない、systemMessageには残す) |
| critical/important、retry <= 3 | ブロック(exit 2)、指摘内容を返す |
| critical/important、retry > 3 | ブロック継続、人間の介入待ち。エスケープハッチ案内 |
| minorのみ/findingsなし | pass(exit 0)、retry_countリセット |
| 検証プロセス自体の失敗(タイムアウト等)、または出力JSONの解析失敗 | fail-open(exit 0、警告のみ) |
| `.skip`マーカーあり | 無条件pass、マーカー消費(Stop hook側のロジックはissue #348で変更なし)。**ただしマーカー作成自体はPreToolUse hook(`scripts/check-skip-marker-write.sh`)でask強制(issue #348)** |

## 運用インシデント(postmortem)

### Stop hook再帰発火による`claude -p`サブプロセス増殖(2026-07-14 / 2026-07-15の2回発生)

**原因:** `claude -p`で起動する検証サブプロセスが、デフォルトでsettings.json(hooks含む)を継承する。
そのため、サブプロセス自身がStopするタイミングでStop hook一式(verify-claims.sh自身・グローバルの
通知hook等)が再発火し、そのネストしたセッションもまた同じ理由で子プロセスを生む…という連鎖が発生した。

**1回目(2026-07-14):** 約15分で343個の別セッションが生成され、そのそれぞれがグローバルの通知hook
(アラート音 + 当時は`git add -A`も実行していた)を実行し続けた。「見えているウィンドウとは無関係に
アラート音が鳴り続ける」という症状として発覚した。対応として`--setting-sources ""` /
`--no-session-persistence`を追加する修正(コミット39d32b2、ブランチ`claude/keen-bohr-fcd6a0`)を
作成したが、**このブランチではPRを作成せず、コミットのみで放置した**。

**2回目(2026-07-15):** 1回目の修正がmainに未マージだったため、別のworktree
(`remaining-issues-320c09`)で全く同じ再帰が再発した。作業中のセッション自身のStopのたびに
発火しており、確認時点で常時10〜15個の`claude -p`プロセスが数秒おきに入れ替わりながら
存在していた。暴走プロセスをkillした上で、同じ修正を当該worktreeに再適用し、PR #357としてmainにマージした。

**教訓:**
1. 修正コミットを作っただけでは再発を防げない。**PRを作ってmainにマージするところまでが修正の完了条件**。
2. 通知音の抑制や`git add -A`の削除は症状(副作用)への対処であり、再帰そのもの(プロセス増殖)は止めない。
   この2つは別のインシデント対応として別途実施済み(グローバルの`~/claude_stop_notify.sh`から
   `git add -A`を削除、グローバル`settings.json`のdenyに`git add -A`/`.`/`--all`を追加)。
3. 「正しい修正が存在すること」と「その修正が実際に適用されていること」は別物であり、後者を機械的に
   保証する手段がない限り同じ事故は繰り返される(→次節「サーキットブレーカー」)。

## サーキットブレーカー

上記インシデントは、**個別の修正が正しくても、それが適用され忘れる・マージされ忘れることで
同じ事故が繰り返される**ことを示した。これに対する構造的な安全策として、以下2つを候補とするが、
**両者は防いでいる失敗モードが異なり、優先順位も異なる**ことを明記しておく。

1. **同時実行数の上限(本丸の対策)**: 「検証用`claude -p`プロセスが再帰的に増殖する」という
   今回実際に起きた失敗モードそのものを止める。例: `.claude/.verify-lock/`配下にPIDファイルを
   置き、同時に実行中の検証プロセス数が一定数(例: 3〜5)を超えたら新規起動を拒否しfail-open
   (警告のみでexit 0)する。`--setting-sources ""`のような個別修正の正しさに依存せず、
   仮に将来同種の再帰バグが別の経路で混入しても被害を頭打ちにできる。
2. **`--max-budget-usd`によるコスト上限(補完策・別の失敗モード用)**: これは「1回の`claude -p`
   呼び出しが暴走して高額課金される」という**別の失敗モード**への対策であり、今回のように
   「Haiku+短いプロンプトで1回あたりは安いが、それが大量に積み重なる」ケースには単体では
   効かない。**「予算上限さえ付ければ今回のような事故は防げる」わけではない**ことに注意。

→ 1が主・2が従。1の実装(具体的なロック機構の設計)は本ドキュメントのスコープ外とし、
別issueとして切り出す。

## ブロックループ中の他hookとの相互作用

`docs/agents/common.md`のissue #339棚卸しレビュー指摘(9/9)への対応。Stopのたびに
verify-claims / doc-suggest-check / ai-check-suggest / claude_stop_notify(通知音) /
claude_auto_issue / aidd_session_report が並走する。Claude Codeのhook実行モデル上、
**同一Stopイベント内で複数のhookは並列実行され、互いの終了コードを実行時に知る手段はない**
(hookは独立したOSプロセスであり、IPCが無い。唯一の連携手段は「前回のhook実行が書き残した
状態ファイルを、次回のhook実行が読む」という**イベントをまたいだ**形のみ)。この制約を踏まえ、
以下の方針とする:

- **初回のブロック判定**(diffハッシュ不一致→LLM呼び出し中)は、他hookが並列実行されるため
  事前に検知できない。通知音が1回鳴ることは許容する
- **リトライループ中**(diffハッシュ一致 かつ 状態ファイルの`last_verdict == "blocked"`。
  「スキップ・再判定ロジック」節の(2)のケース)は、この状態が**前回のStopイベントで既に
  書き込み済み**であるため、今回のStopイベントの開始時点で他hookから読み取り可能。
  よって `claude_stop_notify.sh` / `claude_auto_issue.sh` は起動時に、cwd配下の
  `.claude/.verify-state/<session_id>.json` を読み、現在のdiffハッシュ(既存のverify-claims.sh
  と同じ計算方法)が `last_diff_hash` と一致し `last_verdict == "blocked"` であれば、
  通知音・auto_issue処理をスキップする
- この判定ロジックはグローバルスクリプト側(`~/claude_stop_notify.sh`、`~/claude_auto_issue.sh`)
  に実装する必要がある。`verify-claims.sh`が存在しない/未実行のプロジェクトでは状態ファイルも
  存在しないため、従来通りの挙動になる(後方互換)
- 実装(グローバルスクリプトの変更)は本ドキュメントのスコープ外とし、別issueとして切り出す

## テスト方針

`scripts/` 配下に既存のテスト基盤が無いため、新規に簡易テストを用意する:

- 合成したhook入力JSON(`{"session_id": "test-xxx"}`)を標準入力で渡し、`scripts/verify-claims.sh` を直接実行する
- 検証対象のシナリオ:
  1. diff無し → 即pass
  2. diff一致・前回pass → 即pass(LLM呼び出しが発生しないこと)
  3. diff一致・前回blocked → LLM呼び出し無しでretry_count+1、再ブロック
  4. diff不一致・critical finding → ブロック、状態ファイルにblocked+retry_count記録
  5. retry_countが3を超える → ブロック継続。**(issue #348)** ブロックメッセージに`touch`という語を含まないこと・「人間に相談」という文言を含むことをアサートする(具体的なコマンド案内を削除したため)
  6. `.skip`マーカーあり → 無条件pass、マーカーファイルが削除される
  7. 検証プロセス自体が失敗(モック) → fail-openでpass
  8. 同時実行数が上限に達している → サーキットブレーカーでfail-open(LLM呼び出し無し)
  9. **(issue #352)** untrackedファイルのみ追加・修正 → ハッシュが変わり再検証される(新規ファイル追加時に1回、その後中身を書き換えたときにもう1回、計2回LLM呼び出しが発生すること)
  10. **(issue #354)** evidenceが実在しないファイルを指すcritical finding → minorへ格下げされブロックされない(exit 0)
  11. **(issue #354)** evidenceのファイルは実在するが行番号がファイルの行数を超えるcritical finding → minorへ格下げされブロックされない(exit 0)
  12. **(issue #354)** evidenceが空/ファイルパスらしきトークンを含まないcritical finding → minorへ格下げされブロックされない(exit 0)
- `claude -p` 呼び出し部分は実行コストがかかるため、テストではモック(固定のfindings JSONを返すダミースクリプト)に差し替えて検証する

**(issue #348)** PreToolUse hook `scripts/check-skip-marker-write.sh` 単体の回帰テストは
`scripts/check-skip-marker-write.test.sh` に分離した(Stop hook本体とは別プロセス・別入力形式の
ため)。合成した`tool_name`/`tool_input`のhook入力JSONを標準入力で渡し、以下を確認する:
  1. `Bash`で`command`が`touch .claude/.verify-state/abc.skip` → `permissionDecision: "ask"`が出力される
  2. `Bash`で`command`が`echo x > .claude/.verify-state/abc.skip`(リダイレクト経由) → 同様に`ask`
  3. `Write`で`file_path`が`.claude/.verify-state/abc.skip` → 同様に`ask`
  4. `Bash`で`command`が無関係な通常コマンド(例: `npm test`) → 何も出力されない(exit 0、空出力)
  5. `Bash`で`command`が`.claude/.verify-state/`配下だが`.skip`拡張子ではないファイル(例: `cat *.json`)への操作 → 何も出力されない
  6. **(issue #348追加修正)** `command`が`cd .claude/.verify-state && touch abc.skip`という単一コマンド(cwdフィールド併用) → `ask`
  7. **(issue #348追加修正)** 事前に`cd .claude/.verify-state`済みのcwdから`command`が`touch abc.skip`のみ → `ask`
  8. `command`が`python3 -c "open('.claude/.verify-state/abc.skip','w').close()"`のようなpython3経由の書き込み → `ask`
  9. `command`が`node -e "require('fs').writeFileSync('.claude/.verify-state/abc.skip','')"`のようなnode経由の書き込み → `ask`
  10. `Edit`で`file_path`が`.claude/.verify-state/abc.skip` → `ask`

## 対象範囲外(YAGNI)

- Stop以外のhookイベントへの拡張は今回のスコープ外。**ただし例外として、issue #348のエスケープ
  ハッチ濫用対策(`.skip`マーカー作成行為そのものへのask強制)のみPreToolUse hookを追加した。**
  これはStop hook本体の判定ロジック拡張ではなく、Stop hookとは独立した別の権限制御であり、
  上記「エスケープハッチ(誤検知対策)」節を参照
- CLIセッション(Claude Code CLI)側への同様の仕組みの導入は行わない(CLIはアドバイスのみの方針を維持)
- severity分類自体のチューニング(閾値の精度向上等)は運用開始後の継続課題とする

**検証の網羅性は保証しない。** Haikuモデル・トランスクリプトの抜粋(直前ターンのみ)・60秒の
タイムアウトという軽量な構成であるため、偽陰性(本来指摘すべき問題を見逃す)は普通に起こり得る。
このhookを通過した(exit 0で終わった)ことは「その変更が正しいことの証明」ではなく、「明らかな
主張齟齬・粗い見落としを減らすための軽量フィルタを1つ通過した」という意味でしかない。人間による
レビュー・既存のテスト/lint/型チェックの代替にはならない。
