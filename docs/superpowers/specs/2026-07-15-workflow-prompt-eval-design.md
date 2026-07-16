# AIDDワークフロープロンプトのeval基盤 設計（Issue #391）

## 背景
PR #390（issue #389）でdb-implのblocked誤判定をプロンプト文言修正で直したが、Workflow DSL内の
自然言語プロンプトはユニットテスト不可で、修正の検証が「次回実フローで目視確認」頼みになっている。
`docs/agents/common.md`の「検知手段のないルールの棚卸し」に代表される「自然言語指示は強制力・
検知手段がない」という構造的課題への正面対応として、プロンプト自体の回帰テスト（eval）基盤を作る。

## スコープ
- 今回はdb-implプロンプトの3fixture（①DB変更あり ②「該当なし」明記 ③DB言及なし）をMVPとする。
- ただしハーネス自体は汎用化し、将来contract-writer等のプロンプトを追加する際は
  `scripts/eval-fixtures/<name>/` ディレクトリを追加するだけで済む構造にする。

## 1. プロンプトの正本化（プロンプトドリフト対策）
- `.claude/workflows/lib/prompts/db-impl.js` を新規作成。`buildDbImplPrompt(specPath)` が
  db-implプロンプト文字列を返す（正本・Node moduleなのでrequire可・npm testでユニットテスト可）。
- `aidd-phase2.js` 側のインライン文字列は今まで通り手書きで残すが、「このlibと同一内容であること」
  というコメントを付ける（`shouldBlock`等の既存パターンを踏襲。Workflow DSLはrequire不可のため
  インライン複製せざるを得ない）。
- 新規テスト `.claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`:
  `aidd-phase2.js` をテキストとして読み、正規表現でdb-implのテンプレートリテラルを抽出し、
  `buildDbImplPrompt('SPEC.md')` の出力と比較して乖離を検知する。
  - **実装上の注意（ユーザー指摘）**: `${specPath}` のようなテンプレートリテラルの変数展開部分を
    素朴に文字列完全一致で比較すると、変数の扱いでズレる可能性がある。抽出したテンプレート内の
    `${specPath}` 等の変数プレースホルダ部分を正規化してから比較するか、変数展開後の静的部分のみを
    比較対象にすること。実装時に具体的な比較方式を決める。

## 2. Fixture定義（汎用フォーマット）
```
scripts/eval-fixtures/db-impl/
  manifest.json          # { agentType, promptModule, promptFn, model, jsonSchemaRef }
  case-1-db-change/spec.md      expected.json ({"status":"pass"})
  case-2-no-db-change/spec.md   expected.json ({"status":"pass"})
  case-3-ambiguous/spec.md      expected.json ({"status":"blocked"})
```

## 3. 実行ハーネス `scripts/eval-workflow-prompts.sh`
- 引数でfixtureセットのディレクトリ名を受け取る（例: `scripts/eval-workflow-prompts.sh db-impl`）
- 各fixtureごとに:
  1. `mktemp -d` → `git clone --depth 1 file://$REPO_DIR $TMPDIR`（ローカルclone、本体は汚さない。
     隔離方式としてclone/worktree/直接実行の3案を比較し、本体リポジトリを一切汚さないclone方式を採用）
  2. fixtureの `spec.md` を `$TMPDIR/SPEC.md` に配置
  3. `$TMPDIR` で以下を実行:
     ```
     claude -p --agent implementer --model sonnet \
       --json-schema "<AGENT_RESULT_SCHEMA>" \
       --setting-sources "" --no-session-persistence \
       "<promptModule出力>"
     ```
     - **モデルはsonnet固定**（implementer.mdの定義通り。haikuでの代替検証は却下 — 安いモデルで
       evalすると「本番で実際に動くもの」と異なる挙動をテストすることになり、verify-claimsの
       教訓（モックが実環境の挙動を隠す）と同じ穴に落ちるため）
     - `--setting-sources ""` と `--no-session-persistence` は初回コミットから組み込む
       （verify-claims.shが2026-07-14に経験したStop hook再帰暴走と同型の事故を未然に防ぐ）
  4. 返ってきたJSONの `status` を `expected.json` と突合、mismatchなら報告に積む
  5. `$TMPDIR` を削除
- サーキットブレーカー: verify-claims.shと同型。`.claude/.eval-lock` でmkdirロックし、
  同時実行中のeval呼び出し数が上限を超えたら新規実行を待つかスキップする
  （複数人が同時に`npm run eval:workflows`を叩いた場合の暴走防止。初回コミットから組み込む）
- テスト容易性: `EVAL_WORKFLOW_PROMPTS_AGENT_CMD` 環境変数で実エージェント呼び出しをスタブ
  差し替え可能にする（`scripts/eval-workflow-prompts.test.sh`が実課金なしで検証できるように）
- exit 0 = 全fixture合格 / exit 1 = 不一致あり。人間が読めるサマリを標準出力に出す

## 4. 運用
- `package.json` に `"eval:workflows": "scripts/eval-workflow-prompts.sh"` を追加
- `docs/agents/common.md` に以下を追記する:
  - 「`.claude/workflows/*.js` のプロンプト文言を変更したPRは、マージ前に
    `npm run eval:workflows <fixtureセット名>` を手動実行することが望ましい」という運用ルール
  - CI化を見送る理由（実エージェント呼び出しの課金コスト）
  - **（ユーザー指摘を反映）この運用ルール自体が「検知手段のないルール」であることを明記する。**
    「検知手段のないルールの棚卸し」表に本ルールを追加し、「書き忘れに気づく手段が無い」ことを
    正直に記載する。将来の軽量な検知案（例: `.claude/workflows/*.js`が変更されたPRに対し、
    evalが最近実行された形跡＝タイムスタンプファイル等があるかだけを確認するgit hook）を
    「検討の余地あり・今回は見送り」として書き残す。完全なCI統合（実エージェント呼び出し）は
    不要と判断したが、検知手段そのものを丸ごと諦めたわけではないことを次に読む人に伝える。

## テスト方針
- `.claude/workflows/lib/prompts/db-impl.js` のユニットテスト（プロンプト文字列に必要な条件分岐
  文言が含まれるか）
- `workflow-prompt-sync.test.js`（aidd-phase2.jsとの同期検証）
- `scripts/eval-workflow-prompts.test.sh`（ハーネス自体のロジックをスタブコマンドで検証。
  verify-claims.test.shと同様のパターン）
- 実際のfixture 3ケースの実行はnpm testには含めない（実課金が発生するため）。
  `npm run eval:workflows db-impl` は別コマンドとして人間が手動実行する。
