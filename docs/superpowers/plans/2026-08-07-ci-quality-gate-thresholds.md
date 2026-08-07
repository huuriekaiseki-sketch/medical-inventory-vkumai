# CI品質ゲート閾値定義 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** test/lint/RLSの3ゲートについて、現状「動くか/動かないか」の2値判定しかない状態から、①CIで実際に実行される（test/lintはCI job自体が存在しない）②誤差許容率が数値で明文化される、の2点を満たす状態にする。

**Architecture:** 既存の`.github/workflows/e2e.yml`と同じパターン（actions/checkout@v7 → actions/setup-node@v7 node 24 → npm install → 実行）に倣い、`npm test`（vitest単体テスト）と`npm run lint`を実行する新規CI job `quality-gates.yml` を追加する。RLS/IDORは`e2e.yml`の`test:integration`が既に実行しているため新規job追加は不要で、既存挙動に対して数値閾値をdocs側で明文化するのみ。閾値の実体（`--max-warnings`値、retries数）はコード側（`package.json`/`playwright.config.ts`）に既にある/追加する値を正とし、「なぜその数値か」を`docs/agents/decisions.md`系ファイルに記録する（既存の運用ルール、decisions.md:9-13）。

**Tech Stack:** GitHub Actions, npm scripts, vitest, eslint (eslint-config-next, flat config)

## Global Constraints

- GitHub Actionsの既存パターンに合わせる: `actions/checkout@v7`, `actions/setup-node@v7` with `node-version: '24'`, `cache: 'npm'`（`.github/workflows/e2e.yml:18,29-32`参照）
- **このリポジトリはGitHub Freeプランの非公開リポジトリのため、branch protection（必須ステータスチェック）のAPIが使えない**（`gh api .../branches/main/protection`が403 "Upgrade to GitHub Pro or make this repository public"を返すことを確認済み）。したがって今回追加するCI jobは、PR画面に赤バツ（failing check）として可視化するところまでが到達点であり、**マージボタン自体を機械的にブロックすることはできない**。この制約はdocs/agents/decisions.mdに明記し、他のゲート説明から参照する
- 現状のベースライン（2026-08-07時点、worktree内で実測）: `npm test` = 183ファイル/1402件全pass・15.25秒。`npm run lint` = 0 errors, 2 warnings（`.claude/workflows/lib/__tests__/eval-fixture-manifest-schema-sync.test.js`の未使用eslint-disableコメント2箇所）。`playwright.config.ts:17`は既に`retries: process.env.CI ? 1 : 0`でCI時1回リトライを許容済み

---

### Task 1: lint警告2件を解消する（0警告閾値の前提を作る）

**Files:**
- Modify: `.claude/workflows/lib/__tests__/eval-fixture-manifest-schema-sync.test.js:50,63`

**Interfaces:**
- Consumes: なし
- Produces: `npm run lint`の警告件数が0件になる（Task 2で`--max-warnings=0`を設定する前提条件）

- [ ] **Step 1: 現状の警告を再確認する**

Run: `npm run lint`
Expected: `.claude/workflows/lib/__tests__/eval-fixture-manifest-schema-sync.test.js`の50行目・63行目に`Unused eslint-disable directive (no problems were reported from 'no-new-func')`が出力され、`0 errors, 2 warnings`で終わる

- [ ] **Step 2: 不要なeslint-disableコメントを削除する**

50行目付近（1つ目）:
```js
    // AGENT_RESULT_SCHEMAはJS構文のオブジェクトリテラル(キーがクォートされていない等)であり
    // JSON.parseできないため、Functionコンストラクタでリテラルとして評価する。関数・外部参照を
    // 含まない前提はファイル先頭のコメントで確認済み。
    const schemaObject = new Function(`return (${schemaSource})`)()
```
（直前の`// eslint-disable-next-line no-new-func`行を削除する）

63行目付近（2つ目）:
```js
    const schemaObject = new Function(`return (${schemaSource})`)()
```
（直前の`// eslint-disable-next-line no-new-func`行を削除する。周辺のコメント文言は変更しない）

- [ ] **Step 3: lintが0警告になったことを確認する**

Run: `npm run lint`
Expected: `0 errors, 0 warnings`相当の出力（現状の`✖ 2 problems`行が消える）

- [ ] **Step 4: 単体テストが引き続き通ることを確認する**

Run: `npm test`
Expected: 変更したファイルは`describe`ブロックの外側のコメント削除のみなので、183 test files / 1402 tests all pass のまま変化しないこと

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/lib/__tests__/eval-fixture-manifest-schema-sync.test.js
git commit -m "chore: remove unused eslint-disable directives to unblock 0-warning lint threshold"
```

---

### Task 2: `npm test`・`npm run lint`をCIで実行するjobを新設し、lintの警告閾値を0に固定する

**Files:**
- Modify: `package.json:9`（lint scriptに`--max-warnings=0`を追加）
- Create: `.github/workflows/quality-gates.yml`

**Interfaces:**
- Consumes: Task 1で警告0件になった状態
- Produces: PR作成時に「Quality Gates / test-and-lint」というcheckがGitHub上に表示される（Task 3のdocsから参照するjob名）

- [ ] **Step 1: `package.json`のlint scriptを変更する**

`package.json:9`を以下に変更:
```json
    "lint": "eslint --max-warnings=0",
```

- [ ] **Step 2: ローカルで新しいlintコマンドを確認する**

Run: `npm run lint`
Expected: exit code 0（Task 1適用済みなら警告0件なので`--max-warnings=0`でも失敗しない）

- [ ] **Step 3: 新規CI workflowファイルを作成する**

`.github/workflows/quality-gates.yml`を新規作成:
```yaml
name: Quality Gates

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: quality-gates-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '24'  # ローカル開発環境に合わせる（node -v で確認、e2e.yml:31と同じ）
          cache: 'npm'

      - name: Install dependencies
        run: npm install

      - name: Run unit tests
        run: npm test

      - name: Run lint
        run: npm run lint
```

- [ ] **Step 4: YAML構文を確認する**

Run: `node -e "require('js-yaml') ? '' : ''" 2>/dev/null; python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/quality-gates.yml'))" 2>&1 || cat .github/workflows/quality-gates.yml`

Expected: パースエラーが出ないこと（`python3`が無ければ目視でインデント崩れがないか確認する）

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/quality-gates.yml
git commit -m "feat: add CI job for unit tests and lint, enforce zero-warning lint threshold"
```

---

### Task 3: test/lint/RLS 3ゲートの数値的な合否ラインをdecisionsドキュメントに明記する

**Files:**
- Modify: `docs/agents/decisions.md`（cross-domainな制約として、branch protectionが使えない旨を1箇所に書く）
- Modify: `docs/agents/decisions/aidd-pipeline.md`（test/lintゲートの閾値）
- Modify: `docs/agents/decisions/db-rls.md`（RLS/IDORゲートの閾値）

**Interfaces:**
- Consumes: Task 2で作った`quality-gates.yml`のjob名（`test-and-lint`）、既存`e2e.yml`の`test:integration`ステップ名（`Run RLS/IDOR integration tests`）
- Produces: なし（ドキュメントのみ、他タスクからの依存なし）

- [ ] **Step 1: `docs/agents/decisions.md`に横断的な制約を1エントリ追記する**

既存の見出し構成（decisions.md:15の「分野別ファイル」節の直後）に、以下のセクションを追記する（`## 分野別ファイル（issue #491で分割）`の節の直後、`## なぜdomain.md/decisions.mdを単一ファイルで始めたか`の節の直前に挿入）:

```markdown
## なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか

**結論: このリポジトリはGitHub Freeプランの非公開リポジトリであり、branch protection（必須ステータスチェック）APIが使えないため。**

`gh api repos/<owner>/<repo>/branches/main/protection`は`403 Upgrade to GitHub Pro or make
this repository public to enable this feature`を返す（2026-08-07確認）。このため
test/lint/RLSいずれのCI jobも、PR画面にfailing checkとして表示することはできるが、
「必須チェック未達なら[Merge]ボタンを押せなくする」という機械的ブロックは設定できない。
公開リポジトリ化またはGitHub Proへのアップグレードをしない限りこの制約は解消しない。

**How to apply:** test/lint/RLSゲートの「閾値超えで止める」という表現は、いずれも
「PR上に赤バツを出す」までを指し、マージそのものの機械的停止を意味しない点を、新しい
ゲートを追加・説明するたびに前提として書く。実際の強制力は、AIDDパイプライン内の
`quality-gate.js`によるdeny-by-default判定（サブエージェント実行フロー内でのみ機能、
`docs/agents/decisions/aidd-pipeline.md`参照）と、人間レビュアーが赤バツを見て
マージを手動で控える運用に依存する。
```

- [ ] **Step 2: `docs/agents/decisions/aidd-pipeline.md`にtest/lintゲートの閾値エントリを追記する**

ファイル末尾に以下を追記する:

```markdown

## なぜtest/lintゲートの誤差許容率を「0件」に設定し、CI job（quality-gates.yml）を新設したか（OBL7評価設計タスク）

**結論: 単体テスト・lintのいずれも失敗0件・警告0件を合否ラインとし、flaky再試行の余地を持たせない。既存のe2e/RLS統合テストのみ`playwright.config.ts:17`のCI内1回リトライを踏襲する。**

2026-07-22のmentor評価（[[project_obl7_kgi_direction]]、Codex側ログ）で、既存の3ゲート
（test/lint/RLS静的チェック）が「動くか/動かないか」のpass/fail判定はあるが「何%まで
誤判定を許容するか」という数値的な合格ラインを事前定義していない点を指摘された
（根拠: `router-risk.js`の346万トークン消費インシデント、issue #500で対応済み）。

調査の結果、実際にはさらに手前の問題があった: `npm test`（vitest単体テスト、183ファイル/
1402件）と`npm run lint`を実行するCI jobがそもそも存在せず、ローカルの`ai:check`実行と
Stop hook（`scripts/ai-check-suggest.sh`）の「未実行なら警告するだけ」に依存していた。
このため今回はまず`.github/workflows/quality-gates.yml`を新設して`npm test`・`npm run lint`
をPRごとに実行するようにした上で、閾値を以下に定めた:

- **単体テスト（vitest）**: 失敗許容率0%（1件でも失敗したらred）。単体テストは外部I/Oに
  依存しない前提のため、flakyを許容する理由がない。flakyが実際に発生した場合は
  「テストの独立性を壊す実装がある」というバグ報告として扱い、閾値を緩めて誤魔化さない
- **lint**: `package.json`のlint scriptに`--max-warnings=0`を追加し、警告も含めて0件を
  合格ラインにした。既存の2件の警告（未使用eslint-disableコメント）は同PRで解消済み
- **e2e/RLS統合テスト（`e2e.yml`の`test:integration`・`test:e2e`）**: 今回は変更していない。
  `playwright.config.ts:17`が既にCI環境でのみ`retries: 1`を設定しており、これを
  「ブラウザ操作特有の一過性の不安定さを1回まで許容し、2回連続失敗なら実装側の問題として扱う」
  という既存の閾値と位置づけて明文化した

[[なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか]]の制約により、
これらは全てPR上の可視化に留まる（`docs/agents/decisions.md`参照）。

**How to apply:** 今後新しいCI jobやテストスイートを追加する際は、追加と同時に「失敗0件」
「警告N件まで」のような数値を本エントリに準じて明記する。「後で閾値を決める」順序ではなく、
mentorスキルの判断軸（閾値を先に決めてからゲートを作る）に従うが、今回は既存の未整備状態
（jobが無い）が先に見つかったため、job新設と閾値明記を同一PRでまとめて行った。
```

- [ ] **Step 3: `docs/agents/decisions/db-rls.md`にRLS/IDORゲートの閾値エントリを追記する**

ファイル末尾に以下を追記する:

```markdown

## なぜRLS/IDORゲート（e2e.ymlのtest:integration）の誤差許容率を「0%」と明文化したか（OBL7評価設計タスク）

**結論: RLS/IDORの統合テスト（`e2e.yml`の`test:integration`ステップ）は既にPRごとに実行されているが、合否ラインが暗黙のままだったため「1件でも失敗したらred、再試行による許容なし」と明記した。**

[[なぜtest/lintゲートの誤差許容率を「0件」に設定し、CI job（quality-gates.yml）を新設したか
（OBL7評価設計タスク）]]と同じmentor指摘（346万トークン消費のルーター誤判定インシデント）
を受けた棚卸しで、RLS側は「静的チェック」という名目のゲートが実質存在しない一方
（`.claude/security-patterns.json`はreminderのみでブロックしない、
`schema-drift-check.yml`は本番監視の事後通知でPRゲートではない）、`e2e.yml:58-59`の
「RLS/IDOR integration tests」（`npm run test:integration`）が実質的なRLSゲートとして
既に全PRで実行されていることを確認した。

この既存jobに対し、以下を合否ラインとして明記する:

- テナント越境アクセス・IDOR系のテストは**1件でも失敗したらCI red**とし、許容率0%とする
  （セキュリティ境界のテストであり、test/lintと異なり「たまたま失敗」を許容する理由がない）
- ブラウザ操作特有の一過性の不安定さ（要素待機タイムアウト等）については
  `playwright.config.ts:17`のCI内1回リトライのみ許容し、2回連続失敗した場合は
  実装側の問題として扱う（test/lint側のエントリと同じ位置づけ）

[[なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか]]の制約により、
これもPR上の可視化止まりであり、マージの機械的ブロックではない。

**How to apply:** RLS/IDOR系のテストを新規追加する際は、このエントリの「0%許容」を
デフォルトの合否ラインとして踏襲する。緩める場合（例: 既知のflaky個別ケースを一時的に
skipする等）は、その理由と再検証タイミングを本エントリに追記してから行う。
```

- [ ] **Step 4: リンク先の見出し名が一致しているか確認する**

Task 3 Step 1で追加した見出し`## なぜCI品質ゲートの失敗が赤バツ表示止まりで、マージボタン自体は止められないか`の文字列と、Step 2・Step 3内の`[[...]]`リンク文字列が完全一致していることを目視で確認する（このリポジトリの`[[...]]`はGitHub上でクリック可能なリンクではなく検索用の目印なので、文字列一致のみで足りる）。

- [ ] **Step 5: Commit**

```bash
git add docs/agents/decisions.md docs/agents/decisions/aidd-pipeline.md docs/agents/decisions/db-rls.md
git commit -m "docs: define numeric pass thresholds for test/lint/RLS CI gates"
```

---

## Self-Review メモ

- **Spec coverage**: test gate（Task 1・2で0失敗閾値、Task 3で明記）／lintゲート（Task 1・2で0警告閾値）／RLS静的チェックゲート（Task 3で既存e2e.ymlのtest:integrationを実質ゲートとして0%許容を明記）／CI組み込み（Task 2の`quality-gates.yml`新設）を全てカバー
- **既知の未対応スコープ（意図的に対象外）**: GitHub branch protectionによる機械的マージブロックはプラン不可（Global Constraints・Task 3 Step 1に理由を明記）。`router-risk.js`のキーワード誤判定そのものの再修正はissue #500で対応済みのため本プランの対象外
