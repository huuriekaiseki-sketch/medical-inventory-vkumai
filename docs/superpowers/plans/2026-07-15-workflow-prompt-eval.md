# AIDDワークフロープロンプトのeval基盤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** db-implプロンプト（`.claude/workflows/aidd-phase2.js`）に対し、fixture SPEC.md → 実エージェント実行（`claude -p --agent implementer`、本番と同じsonnet） → 期待status判定のassert、という回帰テストを行うeval基盤を作る。

**Architecture:** db-implプロンプトの正本を`.claude/workflows/lib/prompts/db-impl.js`に切り出し（Workflow DSL側はインライン複製・sync testで乖離検知）、汎用fixtureフォーマット（`scripts/eval-fixtures/<name>/manifest.json` + `case-*/spec.md` + `expected.json`）を`scripts/eval-workflow-prompts.sh`が読み、各fixtureをtmpにcloneした隔離環境で実行してstatusを突合する。verify-claims.shと同型のサーキットブレーカー（`--setting-sources ""` / `--no-session-persistence` / 同時実行数上限）を初回コミットから組み込む。

**Tech Stack:** Bash（既存の`scripts/verify-claims.sh`と同じパターン）、Node.js ESM（`.claude/workflows/lib/`と同じvitestテスト対象）、jq。

## Global Constraints

- Bashコマンドは1回の呼び出しで単一コマンドのみ（`&&`・パイプ・`;`禁止） — ただしこれはこのセッションのBashツール呼び出し自体への制約であり、これから作成するシェルスクリプトファイルの中身には適用されない（スクリプトファイル内は通常のBash構文でよい）
- コードを書いたらWHYを日本語で説明する
- テストコードを一緒に提案する
- 変更は小さく、ステップごとに確認を取る
- db-implプロンプトの本文（`.claude/workflows/aidd-phase2.js`側と`lib/prompts/db-impl.js`側）は**一字一句同一**に保つこと（sync testが検証する対象。改行位置・句読点も含めて完全一致させる）
- fixture実行のモデルは`sonnet`固定（haiku代替は不採用。design docの理由を参照）
- 実際に`claude -p`を呼ぶ最終スモークテスト（Task 8）は実課金が発生するため、実行前に必ずユーザーに確認する

---

### Task 1: テンプレートリテラル抽出ユーティリティ

Workflow DSL側（`aidd-phase2.js`）とlib側（`db-impl.js`）の2箇所に重複するdb-implプロンプトの生テキストを、変数展開を評価せずに比較するための共通ヘルパー。

**Files:**
- Create: `.claude/workflows/lib/prompts/extract-template-literal.js`
- Test: `.claude/workflows/lib/__tests__/extract-template-literal.test.js`

**Interfaces:**
- Produces: `extractTemplateLiteralContaining(sourceText: string, contentMarker: string): string` — `sourceText`中のバッククォート区切りテンプレートリテラルのうち、中身に`contentMarker`を含む最初の1つを、`${...}`部分も含む生テキストのまま返す。見つからなければthrow。Task 3で使用。

- [ ] **Step 1: 失敗するテストを書く**

`.claude/workflows/lib/__tests__/extract-template-literal.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

describe('extractTemplateLiteralContaining', () => {
  it('マーカーを含むテンプレートリテラルの中身を抽出する', () => {
    const source = "const x = `hello ${name} world, marker-here`\nconst y = `other`"
    expect(extractTemplateLiteralContaining(source, 'marker-here')).toBe('hello ${name} world, marker-here')
  })

  it('${}内にネストした波括弧があっても正しく終端を判定する', () => {
    const source = "const x = `a ${fn({ k: 1 })} b marker`"
    expect(extractTemplateLiteralContaining(source, 'marker')).toBe('a ${fn({ k: 1 })} b marker')
  })

  it('複数のテンプレートリテラルから該当するものだけを選ぶ', () => {
    const source = "const a = `first marker-a`\nconst b = `second marker-b`"
    expect(extractTemplateLiteralContaining(source, 'marker-b')).toBe('second marker-b')
  })

  it('マーカーを含むリテラルが無ければエラーを投げる', () => {
    const source = "const a = `first`"
    expect(() => extractTemplateLiteralContaining(source, 'nope')).toThrow()
  })

  it('複数行にまたがるテンプレートリテラルも抽出できる', () => {
    const source = "const x = `line1\nline2 marker\nline3`"
    expect(extractTemplateLiteralContaining(source, 'marker')).toBe('line1\nline2 marker\nline3')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run .claude/workflows/lib/__tests__/extract-template-literal.test.js`
Expected: FAIL（`extract-template-literal.js`が存在しないためimportエラー）

- [ ] **Step 3: 実装する**

`.claude/workflows/lib/prompts/extract-template-literal.js`:
```js
// ソーステキスト中のテンプレートリテラル（バッククォート区切り）を、${...}のネスト
// （波括弧を含む式も可）を考慮しつつ全て走査し、中身にcontentMarkerを含む最初の1つを
// 生テキスト（変数展開を評価しない、${specPath}等がそのまま残った状態）で返す。
//
// 用途: Workflow DSL（require不可）内にインライン複製されたプロンプト文字列と、lib側の
// 正本を「評価せず生テキストとして」比較するため（workflow-prompt-sync.test.js参照）。
// 変数展開後の値で比較すると、比較用に別途変数を用意する必要があり実装が複雑化するうえ、
// 変数の扱いでズレが生じうる。生テキスト比較ならその心配がない（issue #391 design doc参照）。
//
// 制約: リテラル内部にバッククォート文字そのものが含まれるケース（ネストしたテンプレート
// リテラル）は非対応。現状のワークフロープロンプトはこのケースに該当しない。
export function extractTemplateLiteralContaining(sourceText, contentMarker) {
  const literals = []
  let i = 0
  while (i < sourceText.length) {
    if (sourceText[i] === '`') {
      const start = i + 1
      let j = start
      let interpolationDepth = 0
      while (j < sourceText.length) {
        const ch = sourceText[j]
        if (interpolationDepth === 0 && ch === '`') break
        if (interpolationDepth === 0 && ch === '$' && sourceText[j + 1] === '{') {
          interpolationDepth = 1
          j += 2
          continue
        }
        if (interpolationDepth > 0) {
          if (ch === '{') interpolationDepth++
          else if (ch === '}') interpolationDepth--
        }
        j++
      }
      literals.push(sourceText.slice(start, j))
      i = j + 1
      continue
    }
    i++
  }
  const found = literals.find(text => text.includes(contentMarker))
  if (found === undefined) {
    throw new Error(`extractTemplateLiteralContaining: no template literal contains marker: ${contentMarker}`)
  }
  return found
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run .claude/workflows/lib/__tests__/extract-template-literal.test.js`
Expected: PASS（5件全て）

- [ ] **Step 5: コミット**

```bash
git add .claude/workflows/lib/prompts/extract-template-literal.js .claude/workflows/lib/__tests__/extract-template-literal.test.js
git commit -m "feat: ワークフロープロンプト同期検証用のテンプレートリテラル抽出ユーティリティ追加(issue #391)"
```

---

### Task 2: db-implプロンプトの正本をlibへ切り出す

**Files:**
- Create: `.claude/workflows/lib/prompts/db-impl.js`
- Test: `.claude/workflows/lib/__tests__/db-impl-prompt.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `buildDbImplPrompt(specPath: string): string` — db-impl agent向けの完全なプロンプト文字列。Task 3のsync test、Task 5のfixture実行（`scripts/lib/build-eval-prompt.mjs`経由）で使用。

- [ ] **Step 1: 失敗するテストを書く**

`.claude/workflows/lib/__tests__/db-impl-prompt.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { buildDbImplPrompt } from '../prompts/db-impl.js'

describe('buildDbImplPrompt', () => {
  it('specPathを本文に埋め込む', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('まず SPEC.md を Read ツールで読んでください')
  })

  it('DBスキーマ変更が不要な場合はblockedではなくpassにする旨を明記している(issue #389再発防止)', () => {
    const prompt = buildDbImplPrompt('SPEC.md')
    expect(prompt).toContain('これはblocked（着手不能）ではない')
  })

  it('DB変更不要の判断根拠をdetailに書くよう指示している', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('該当なし')
  })

  it('触ってよい範囲の制約(src/types等は触らない)を含む', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('src/types/ / src/lib/ / src/app/ は触らないこと')
  })

  it('出力形式(status/detail/findings)の指示を含む', () => {
    const prompt = buildDbImplPrompt('SPEC.md')
    expect(prompt).toContain('## 出力形式')
    expect(prompt).toContain('pass:')
    expect(prompt).toContain('blocked:')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run .claude/workflows/lib/__tests__/db-impl-prompt.test.js`
Expected: FAIL（`db-impl.js`が存在しない）

- [ ] **Step 3: 実装する**

`.claude/workflows/lib/prompts/db-impl.js`:
```js
// db-impl（.claude/workflows/aidd-phase2.js）のプロンプト文字列の正本。
// Workflow DSLはrequire不可のため、aidd-phase2.js側には同一内容をインライン複製している
// （guide()も含めて複製。quality-gate.js/severity.js等の既存パターンと同じ制約）。
// 両者の同期は .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js が検証する。
//
// **重要**: このファイルのテンプレートリテラル本文（バッククォート内）を変更したら、
// aidd-phase2.js内の対応するインライン複製も一字一句同じ内容に更新すること。
// sync testが乖離を検知するが、修正自体は手動で行う必要がある(issue #391)。
const guide = (pass, fail, blocked) => `

## 出力形式
status と detail を返すこと。
- pass: ${pass}
- fail: ${fail}
- blocked: ${blocked}

failの場合はfindings配列（{ severity: critical/important/minor, description }）で指摘ごとに
重大度を明記すること。findings全件がminorならこのゲートは通過扱いになる。
findingsを省略した場合、またはcritical/important指摘が1件でもあれば差し戻し対象になる
（severity不明・欠損はcritical扱い。fail-open防止）。`

export function buildDbImplPrompt(specPath) {
  return `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。\nPart 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。${guide(
    'マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した',
    'マイグレーションを試みたがエラー・矛盾がある',
    'SPEC.mdが存在しない、またはPart2にDB変更の要否自体を判断できる記載が無い'
  )}`
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run .claude/workflows/lib/__tests__/db-impl-prompt.test.js`
Expected: PASS（5件全て）

- [ ] **Step 5: コミット**

```bash
git add .claude/workflows/lib/prompts/db-impl.js .claude/workflows/lib/__tests__/db-impl-prompt.test.js
git commit -m "feat: db-implプロンプトの正本をlib/prompts/db-impl.jsへ切り出し(issue #391)"
```

---

### Task 3: aidd-phase2.jsとの同期テスト + リンクコメント追加

**Files:**
- Modify: `.claude/workflows/aidd-phase2.js:218`（db-impl agent()呼び出しの直前にコメント追加。プロンプト本文自体は変更しない）
- Test: `.claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`

**Interfaces:**
- Consumes: `extractTemplateLiteralContaining`（Task 1）、`buildDbImplPrompt`は使わない（生テキスト比較のためlib/prompts/db-impl.jsのファイル内容を直接読む）

- [ ] **Step 1: 失敗するテストを書く**

`.claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../prompts/db-impl.js')
// db-implプロンプトにのみ登場する文字列。他のagent()呼び出し(contract-writer等)の
// テンプレートリテラルと誤って一致しないことを保証するため、十分に特徴的な一節を選ぶ。
const CONTENT_MARKER = 'Part 2にDBスキーマ変更が不要と明記されている場合'

describe('db-implプロンプトの同期(issue #391)', () => {
  it('aidd-phase2.js内のインライン複製がlib/prompts/db-impl.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libTemplate = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowTemplate).toBe(libTemplate)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する（まだコメントを追加していない段階でも一致するはずなので、まず現状で実行してPASSすることを確認する）**

Run: `npx vitest run .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`
Expected: PASS（Task 2でaidd-phase2.jsと一字一句同じ内容をlibに書いたため、この時点で既に一致している。これは「今は同期している」ことの確認であり、次のStep 3でコメントのみ追加しても一致が壊れないことを確認するのが本質）

- [ ] **Step 3: aidd-phase2.jsにリンクコメントを追加する**

`.claude/workflows/aidd-phase2.js` の該当箇所（db-impl agent()呼び出しの直前）を編集する。

変更前:
```js
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。\nPart 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。${guide(
      'マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した',
      'マイグレーションを試みたがエラー・矛盾がある',
      'SPEC.mdが存在しない、またはPart2にDB変更の要否自体を判断できる記載が無い'
    )}`,
    { label: 'db-impl', phase: 'Contract + DB', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
```

変更後:
```js
  // db-implプロンプトの正本は .claude/workflows/lib/prompts/db-impl.js（buildDbImplPrompt）。
  // Workflow DSLはrequire不可のためここに同一内容をインライン複製している。
  // 一字一句の同期は .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js が検証する
  // （npm testに含まれる。乖離時は即座にテスト失敗する。issue #391）。
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。\nPart 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。${guide(
      'マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した',
      'マイグレーションを試みたがエラー・矛盾がある',
      'SPEC.mdが存在しない、またはPart2にDB変更の要否自体を判断できる記載が無い'
    )}`,
    { label: 'db-impl', phase: 'Contract + DB', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
```

- [ ] **Step 4: テストが引き続き通ることを確認する（コメント追加はテンプレートリテラル本文の外なので影響しないはず）**

Run: `npx vitest run .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`
Expected: PASS

- [ ] **Step 5: 意図的にlib側を1文字変えてテストが落ちることを確認する（動作確認後、必ず元に戻す）**

一時的に `.claude/workflows/lib/prompts/db-impl.js` の `'該当なし'` を `'該当無し'` に変更し、
Run: `npx vitest run .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js`
Expected: FAIL（テンプレートリテラルの不一致でexpect().toBe()が失敗する）

確認後、変更を元に戻す（`git checkout -- .claude/workflows/lib/prompts/db-impl.js`）。

- [ ] **Step 6: コミット**

```bash
git add .claude/workflows/aidd-phase2.js .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js
git commit -m "test: db-implプロンプトのworkflow/lib間同期を検証するテストを追加(issue #391)"
```

---

### Task 4: fixture用プロンプトビルドヘルパー

eval harness（Bashスクリプト）から、cloneした一時リポジトリ内の`lib/prompts/db-impl.js`を呼び出してプロンプト文字列を得るためのCLIラッパー。

**Files:**
- Create: `scripts/lib/build-eval-prompt.mjs`
- Test: `scripts/lib/build-eval-prompt.test.mjs`

**Interfaces:**
- Produces: CLI `node scripts/lib/build-eval-prompt.mjs <絶対パスのモジュール> <関数名> <specPath>` — 標準出力にプロンプト文字列を書く。Task 6のeval-workflow-prompts.shが呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`scripts/lib/build-eval-prompt.test.mjs`:
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('build-eval-prompt.mjs', () => {
  let tmpDir
  let modulePath

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'build-eval-prompt-test-'))
    modulePath = path.join(tmpDir, 'sample-prompt.js')
    writeFileSync(
      modulePath,
      "export function buildSample(specPath) { return `hello ${specPath}` }\n"
    )
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('指定したモジュール・関数・引数でプロンプト文字列を標準出力に書く', () => {
    const out = execFileSync('node', [
      path.resolve('scripts/lib/build-eval-prompt.mjs'),
      modulePath,
      'buildSample',
      'SPEC.md',
    ]).toString()
    expect(out).toBe('hello SPEC.md')
  })

  it('存在しない関数名を指定するとエラー終了する', () => {
    expect(() =>
      execFileSync('node', [
        path.resolve('scripts/lib/build-eval-prompt.mjs'),
        modulePath,
        'notAFunction',
        'SPEC.md',
      ], { stdio: 'pipe' })
    ).toThrow()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run scripts/lib/build-eval-prompt.test.mjs`
Expected: FAIL（`build-eval-prompt.mjs`が存在しない）

- [ ] **Step 3: 実装する**

`scripts/lib/build-eval-prompt.mjs`:
```js
#!/usr/bin/env node
// eval-workflow-prompts.sh（Bash）からNode ESMモジュールのプロンプトビルド関数を呼ぶための
// 薄いCLIラッパー。Bash側は`.js`のESM/CJS判定に関わりたくないため、.mjs拡張子で明示的に
// ESMとして実行し、動的importでモジュールを読み込む(issue #391)。
import { pathToFileURL } from 'node:url'

const [, , modulePath, fnName, specPath] = process.argv

if (!modulePath || !fnName || specPath === undefined) {
  console.error('usage: build-eval-prompt.mjs <modulePath> <fnName> <specPath>')
  process.exit(1)
}

const mod = await import(pathToFileURL(modulePath).href)
const fn = mod[fnName]
if (typeof fn !== 'function') {
  console.error(`build-eval-prompt: ${fnName} is not exported by ${modulePath}`)
  process.exit(1)
}

process.stdout.write(fn(specPath))
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run scripts/lib/build-eval-prompt.test.mjs`
Expected: PASS（2件）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/build-eval-prompt.mjs scripts/lib/build-eval-prompt.test.mjs
git commit -m "feat: eval harness用のプロンプトビルドCLIヘルパー追加(issue #391)"
```

---

### Task 5: db-impl fixture定義（3ケース）

**Files:**
- Create: `scripts/eval-fixtures/db-impl/manifest.json`
- Create: `scripts/eval-fixtures/db-impl/case-1-db-change/spec.md`
- Create: `scripts/eval-fixtures/db-impl/case-1-db-change/expected.json`
- Create: `scripts/eval-fixtures/db-impl/case-2-no-db-change/spec.md`
- Create: `scripts/eval-fixtures/db-impl/case-2-no-db-change/expected.json`
- Create: `scripts/eval-fixtures/db-impl/case-3-ambiguous/spec.md`
- Create: `scripts/eval-fixtures/db-impl/case-3-ambiguous/expected.json`

このタスクにテストコードは無い（静的なfixtureデータのため）。Task 6のharnessテスト・Task 8のスモークテストで実際に使われることで検証される。

- [ ] **Step 1: manifest.jsonを作成する**

`scripts/eval-fixtures/db-impl/manifest.json`:
```json
{
  "agentType": "implementer",
  "promptModule": ".claude/workflows/lib/prompts/db-impl.js",
  "promptFn": "buildDbImplPrompt",
  "model": "sonnet",
  "jsonSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["pass", "fail", "blocked"] },
      "detail": { "type": "string" },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "severity": { "type": "string", "enum": ["critical", "important", "minor"] },
            "description": { "type": "string" }
          },
          "required": ["severity", "description"]
        }
      }
    },
    "required": ["status", "detail"]
  }
}
```

WHY: `jsonSchema`は`aidd-phase2.js`の`AGENT_RESULT_SCHEMA`と同一内容にしている。実フローで実際にimplementerへ課される出力制約と異なるスキーマでevalすると、本番と違う挙動を検証してしまうため。

- [ ] **Step 2: case-1-db-change（DBスキーマ変更あり→pass期待）を作成する**

`scripts/eval-fixtures/db-impl/case-1-db-change/spec.md`:
```markdown
# SPEC: 在庫アイテムにメモ欄を追加する機能

## Part 1: 概要
在庫アイテム（`inventory_items`テーブル）に、任意のテキストメモを保存できる`memo`カラムを追加する。

## Part 2: 実装計画

### DBスキーマ変更
`inventory_items`テーブルに以下のカラムを追加するマイグレーションを作成する。

- カラム名: `memo`
- 型: `text`
- NULL許容: 可（既存行への影響なし）
- デフォルト値: なし

マイグレーションファイルは `supabase/migrations/` 配下に、既存の命名規則
（`<timestamp>_<説明>.sql`）に従って追加すること。

### 実装セット一覧
1. db-impl: 上記マイグレーションの作成
2. data-impl: （このfixtureでは対象外）
```

`scripts/eval-fixtures/db-impl/case-1-db-change/expected.json`:
```json
{ "status": "pass" }
```

- [ ] **Step 3: case-2-no-db-change（「該当なし」明記→pass期待）を作成する**

`scripts/eval-fixtures/db-impl/case-2-no-db-change/spec.md`:
```markdown
# SPEC: 在庫一覧画面の並び順を変更する機能

## Part 1: 概要
在庫一覧画面のデフォルトの並び順を、登録日時の降順から品目名の昇順に変更する。

## Part 2: 実装計画

### DBスキーマ変更
該当なし。既存のカラム・インデックスのみで対応可能なため、マイグレーションは不要。

### 実装セット一覧
1. ui-impl: 一覧画面のソートロジックをクライアント側で変更する（このfixtureでは対象外）
```

`scripts/eval-fixtures/db-impl/case-2-no-db-change/expected.json`:
```json
{ "status": "pass" }
```

WHY: issue #389で実際に発生した誤判定（DB変更不要ケースをblockedと一律判定してしまう）の再発を検知するための核心fixture。

- [ ] **Step 4: case-3-ambiguous（DB言及なし→blocked期待）を作成する**

`scripts/eval-fixtures/db-impl/case-3-ambiguous/spec.md`:
```markdown
# SPEC: 在庫一覧画面の並び順を変更する機能

## Part 1: 概要
在庫一覧画面のデフォルトの並び順を、登録日時の降順から品目名の昇順に変更する。

## Part 2: 実装計画

### 実装セット一覧
1. ui-impl: 一覧画面のソートロジックをクライアント側で変更する（このfixtureでは対象外）

（DBスキーマ変更に関する記載なし）
```

`scripts/eval-fixtures/db-impl/case-3-ambiguous/expected.json`:
```json
{ "status": "blocked" }
```

WHY: 「該当なし」等の明示が無い場合まで自動的にpass扱いしてしまうと、本当にDB変更を見落として実装が進んでしまう危険がある。db-implプロンプトが「DB変更の要否自体を判断できる記載が無い」場合をblockedとする設計になっていることを確認する。

- [ ] **Step 5: コミット**

```bash
git add scripts/eval-fixtures/db-impl/
git commit -m "test: db-implプロンプトeval用fixture3ケースを追加(issue #391)"
```

---

### Task 6: eval実行ハーネス

**Files:**
- Create: `scripts/eval-workflow-prompts.sh`
- Test: `scripts/eval-workflow-prompts.test.sh`

**Interfaces:**
- Consumes: `scripts/lib/build-eval-prompt.mjs`（Task 4）、`scripts/eval-fixtures/<name>/manifest.json` + `case-*/{spec.md,expected.json}`（Task 5のフォーマット）
- Produces: CLI `scripts/eval-workflow-prompts.sh <fixtureセット名>`。exit 0=全fixture合格、exit 1=不一致あり。環境変数`EVAL_WORKFLOW_PROMPTS_AGENT_CMD`でエージェント呼び出しをスタブ差し替え可能（verify-claims.shの`VERIFY_CLAIMS_VERIFIER_CMD`と同じパターン）。

- [ ] **Step 1: テストを書く（スクリプト本体より先に、期待する振る舞いをテストとして定義する。verify-claims.test.shと同じ「先にmockでテストを書いてから実装」のパターン）**

`scripts/eval-workflow-prompts.test.sh`:
```bash
#!/bin/bash
# WHY: eval-workflow-prompts.shはclaude -pのサブプロセス実行を含み実課金が発生するため、
# EVAL_WORKFLOW_PROMPTS_AGENT_CMDでモックに差し替えてfixture突合ロジック・サーキットブレーカーを
# 実課金なしで回帰テストする。verify-claims.test.shと同じパターン(issue #391)。
#
# 実行: bash scripts/eval-workflow-prompts.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/eval-workflow-prompts.sh"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# --- テスト用の最小fixtureセットを用意する ---
FIXTURES_DIR="$WORKDIR/fixtures"
mkdir -p "$FIXTURES_DIR/sample/case-a" "$FIXTURES_DIR/sample/case-b"
cat > "$FIXTURES_DIR/sample/manifest.json" <<'EOF'
{
  "agentType": "implementer",
  "promptModule": "scripts/eval-fixtures/dummy-prompt.js",
  "promptFn": "buildDummyPrompt",
  "model": "sonnet",
  "jsonSchema": { "type": "object", "properties": { "status": { "type": "string" } }, "required": ["status"] }
}
EOF
echo "spec-a" > "$FIXTURES_DIR/sample/case-a/spec.md"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-a/expected.json"
echo "spec-b" > "$FIXTURES_DIR/sample/case-b/spec.md"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-b/expected.json"
# WHY: promptFnは固定のspecPath文字列("SPEC.md")しか受け取らず、spec.mdの中身の違いは
# プロンプト文字列に反映されない（実際にファイル内容を読むのは本物のclaude -pサブプロセスの
# 中身であり、mockからは見えない）。そのためmockはcase-a/case-bを区別できず、両者に対して
# 常に同一の応答を返す。ケースごとに異なる判定を検証したい場合は、mockの応答ではなく
# expected.json側を書き換えて不一致を作る（scenario 2参照）。

# clone元となるダミーrepo(promptModuleを含む)
DUMMY_REPO="$WORKDIR/dummy-repo"
mkdir -p "$DUMMY_REPO/scripts/eval-fixtures"
(
  cd "$DUMMY_REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "export function buildDummyPrompt(specPath) { return 'prompt-for-' + specPath }" > scripts/eval-fixtures/dummy-prompt.js
  git add -A
  git commit -q -m "init"
)

MOCK_AGENT="$WORKDIR/mock-agent.sh"
MOCK_CALL_LOG="$WORKDIR/call.log"
MOCK_RESPONSE_FILE="$WORKDIR/mock-response.json"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
# WHY: プロンプト本文には改行を含まないためcat単独でappendすると呼び出し回数を
# wc -lで数えられない。1呼び出しにつき1行のマーカーを追記して回数を数えられるようにする。
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected to find: $needle / actual: $haystack)"
    fail=1
  fi
}

run_eval() {
  set +e
  OUT="$(
    EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
    EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$FIXTURES_DIR" \
    EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$WORKDIR/lock" \
    EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
    EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
    MOCK_CALL_LOG="$MOCK_CALL_LOG" \
    MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
    bash "$SCRIPT" sample 2>"$WORKDIR/stderr.tmp"
  )"
  EXIT_CODE=$?
  ERR="$(cat "$WORKDIR/stderr.tmp")"
  set -e
}

echo "=== scenario 1: 全fixtureが期待通り → exit 0 ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
run_eval
assert_eq "$EXIT_CODE" "0" "全fixture合格でexit 0"
assert_eq "$(wc -l < "$MOCK_CALL_LOG" | tr -d ' ')" "2" "case-a/case-bそれぞれ1回ずつ、計2回エージェントが呼ばれる"

echo "=== scenario 2: 1件のstatusが期待と不一致 → exit 1、報告に不一致が含まれる ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "blocked" }' > "$FIXTURES_DIR/sample/case-b/expected.json"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
run_eval
assert_eq "$EXIT_CODE" "1" "case-bはblocked期待だがmockはpassを返すため不一致でexit 1"
assert_contains "$OUT" "case-b" "不一致fixtureの名前が報告に含まれる"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-b/expected.json"

echo "=== scenario 3: エージェント呼び出し自体が失敗(non-zero exit) → 失敗として報告、スクリプト自体はクラッシュしない ==="
rm -f "$MOCK_CALL_LOG"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
exit 1
MOCK_EOF
chmod +x "$MOCK_AGENT"
run_eval
assert_eq "$EXIT_CODE" "1" "エージェント呼び出し失敗時もスクリプトはexit 1で正常終了する(クラッシュしない)"
assert_contains "$OUT" "エージェント実行が失敗" "失敗理由が報告に含まれる"
# 元に戻す
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
# WHY: プロンプト本文には改行を含まないためcat単独でappendすると呼び出し回数を
# wc -lで数えられない。1呼び出しにつき1行のマーカーを追記して回数を数えられるようにする。
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

echo "=== scenario 4: 同時実行数が上限に達している → サーキットブレーカーでexit 1、エージェントを呼ばない ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
LOCK_DIR="$WORKDIR/lock-full"
mkdir -p "$LOCK_DIR"
sleep 60 & DUMMY_PID_1=$!
sleep 60 & DUMMY_PID_2=$!
mkdir -p "$LOCK_DIR/$DUMMY_PID_1" "$LOCK_DIR/$DUMMY_PID_2"
set +e
OUT="$(
  EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
  EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$FIXTURES_DIR" \
  EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$LOCK_DIR" \
  EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
  EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
  MOCK_CALL_LOG="$MOCK_CALL_LOG" \
  MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
  bash "$SCRIPT" sample 2>"$WORKDIR/stderr4.tmp"
)"
EXIT_CODE=$?
set -e
kill "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
wait "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
assert_eq "$EXIT_CODE" "1" "同時実行数上限時はexit 1"
assert_contains "$OUT$( [ -f "$WORKDIR/stderr4.tmp" ] && cat "$WORKDIR/stderr4.tmp" )" "サーキットブレーカー" "サーキットブレーカーが働いた旨が報告される"
if [ -f "$MOCK_CALL_LOG" ]; then
  echo "  NG: サーキットブレーカー発動時はエージェントを呼ばないはずだが呼び出しログが存在する"
  fail=1
else
  echo "  OK: サーキットブレーカー発動時はエージェントを呼ばない(呼び出しログが作られない)"
fi

echo "=== scenario 5: claude -p呼び出しに--setting-sources \"\"と--no-session-persistenceが付いている(静的確認) ==="
RUN_AGENT_BLOCK="$(awk '/^run_agent\(\)/,/^}/' "$SCRIPT")"
assert_contains "$RUN_AGENT_BLOCK" '--setting-sources ""' "claude -p呼び出しに--setting-sources \"\"が付いている(Stop hook再帰発火防止)"
assert_contains "$RUN_AGENT_BLOCK" '--no-session-persistence' "claude -p呼び出しに--no-session-persistenceが付いている"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bash scripts/eval-workflow-prompts.test.sh`
Expected: FAIL（`eval-workflow-prompts.sh`が存在しない）

- [ ] **Step 3: 実装する**

`scripts/eval-workflow-prompts.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# AIDDワークフロー内の自然言語プロンプト（.claude/workflows/*.js）を、fixture SPEC.md →
# 実エージェント実行 → 期待status判定のassertで回帰テストするharness(issue #391)。
# 設計: docs/superpowers/specs/2026-07-15-workflow-prompt-eval-design.md
#
# 使い方: scripts/eval-workflow-prompts.sh <fixtureセット名>（例: db-impl）
#
# fixtureセットは scripts/eval-fixtures/<name>/ に以下の形式で置く:
#   manifest.json         { agentType, promptModule, promptFn, model, jsonSchema }
#   case-*/spec.md        fixtureのSPEC.md本文
#   case-*/expected.json  { "status": "pass"|"fail"|"blocked" }
#
# 各fixtureは本体リポジトリを汚さないよう、一時ディレクトリへのlocal clone上で実行する
# （fixtureによっては実際にsupabase/migrations/へファイルを書こうとするため）。
#
# サーキットブレーカー・hooks非継承・セッション非永続化は、verify-claims.shが2026-07-14に
# 経験したStop hook再帰暴走と同型の事故を未然に防ぐため、初回コミットから組み込んでいる。
#
# テスト容易性のため、以下を環境変数で上書き可能にしている（テストはscripts/eval-workflow-prompts.test.sh参照）:
#   EVAL_WORKFLOW_PROMPTS_REPO_DIR      - cloneの複製元リポジトリ（省略時はこのスクリプトの親）
#   EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR  - fixtureセットの置き場所（省略時は $REPO_DIR/scripts/eval-fixtures）
#   EVAL_WORKFLOW_PROMPTS_LOCK_DIR      - サーキットブレーカー用ロック置き場
#   EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT - 同時実行を許すeval呼び出し数の上限（省略時は2）
#   EVAL_WORKFLOW_PROMPTS_TIMEOUT_SECONDS - 1fixtureあたりのタイムアウト秒数（省略時は300。実装作業を伴うため verify-claims.sh より長め）
#   EVAL_WORKFLOW_PROMPTS_AGENT_CMD     - 実際の`claude -p`呼び出しの代わりに使うコマンド

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${EVAL_WORKFLOW_PROMPTS_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FIXTURES_ROOT="${EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR:-$REPO_DIR/scripts/eval-fixtures}"
LOCK_DIR="${EVAL_WORKFLOW_PROMPTS_LOCK_DIR:-$REPO_DIR/.claude/.eval-lock}"
MAX_CONCURRENT="${EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT:-2}"
TIMEOUT_SECONDS="${EVAL_WORKFLOW_PROMPTS_TIMEOUT_SECONDS:-300}"

FIXTURE_SET="${1:-}"
if [ -z "$FIXTURE_SET" ]; then
  echo "usage: $0 <fixture-set-name>" >&2
  exit 1
fi

FIXTURE_SET_DIR="$FIXTURES_ROOT/$FIXTURE_SET"
MANIFEST_FILE="$FIXTURE_SET_DIR/manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "eval-workflow-prompts: manifest not found: $MANIFEST_FILE" >&2
  exit 1
fi

AGENT_TYPE="$(jq -r '.agentType' "$MANIFEST_FILE")"
PROMPT_MODULE="$(jq -r '.promptModule' "$MANIFEST_FILE")"
PROMPT_FN="$(jq -r '.promptFn' "$MANIFEST_FILE")"
MODEL="$(jq -r '.model' "$MANIFEST_FILE")"
JSON_SCHEMA="$(jq -c '.jsonSchema' "$MANIFEST_FILE")"

mkdir -p "$LOCK_DIR"

# --- サーキットブレーカー: 同時実行中のeval呼び出し数が上限を超えたら中断する ---
# 死んだプロセスのロックエントリ(前回異常終了で残った分)を先に掃除する(verify-claims.shと同じパターン)。
for entry in "$LOCK_DIR"/*; do
  [ -e "$entry" ] || continue
  entry_pid="$(basename "$entry")"
  if ! kill -0 "$entry_pid" 2>/dev/null; then
    rmdir "$entry" 2>/dev/null || true
  fi
done
CURRENT_CONCURRENT="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CURRENT_CONCURRENT" -ge "$MAX_CONCURRENT" ]; then
  echo "eval-workflow-prompts: 同時実行数が上限(${MAX_CONCURRENT})に達しているため中断しました（サーキットブレーカー）。しばらく待って再実行してください。" >&2
  exit 1
fi
LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

run_agent() {
  local prompt="$1"
  if [ -n "${EVAL_WORKFLOW_PROMPTS_AGENT_CMD:-}" ]; then
    printf '%s' "$prompt" | eval "$EVAL_WORKFLOW_PROMPTS_AGENT_CMD"
    return $?
  fi
  # --setting-sources "": Stop hook等を継承させない(verify-claims.shが2026-07-14に経験した
  # 再帰暴走と同型の事故を防ぐ)。--no-session-persistence: 使い捨て実行のためtranscriptを残さない。
  printf '%s' "$prompt" | claude -p --agent "$AGENT_TYPE" --model "$MODEL" \
    --json-schema "$JSON_SCHEMA" \
    --setting-sources "" \
    --no-session-persistence
}

# ポータブルなタイムアウト実装（verify-claims.shと同じパターン）
run_agent_with_timeout() {
  local out_file
  out_file="$(mktemp)"
  ( run_agent "$1" > "$out_file" 2>/dev/null; echo $? > "${out_file}.exit" ) &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      cat "$out_file" 2>/dev/null || true
      rm -f "$out_file" "${out_file}.exit"
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || true
  local status
  status="$(cat "${out_file}.exit" 2>/dev/null || echo 1)"
  cat "$out_file"
  rm -f "$out_file" "${out_file}.exit"
  return "$status"
}

TOTAL=0
PASS_COUNT=0
FAIL_LINES=""

for case_dir in "$FIXTURE_SET_DIR"/case-*/; do
  [ -d "$case_dir" ] || continue
  case_name="$(basename "$case_dir")"
  spec_file="${case_dir}spec.md"
  expected_file="${case_dir}expected.json"
  if [ ! -f "$spec_file" ] || [ ! -f "$expected_file" ]; then
    echo "eval-workflow-prompts: $case_name はspec.mdまたはexpected.jsonが無いためスキップします" >&2
    continue
  fi
  TOTAL=$((TOTAL + 1))
  EXPECTED_STATUS="$(jq -r '.status' "$expected_file")"

  CLONE_DIR="$(mktemp -d)"
  git clone --quiet --depth 1 "file://$REPO_DIR" "$CLONE_DIR/repo"
  cp "$spec_file" "$CLONE_DIR/repo/SPEC.md"

  PROMPT="$(node "$SCRIPT_DIR/lib/build-eval-prompt.mjs" "$CLONE_DIR/repo/$PROMPT_MODULE" "$PROMPT_FN" "SPEC.md")"

  AGENT_EXIT=0
  AGENT_OUTPUT="$(cd "$CLONE_DIR/repo" && run_agent_with_timeout "$PROMPT")" || AGENT_EXIT=$?
  rm -rf "$CLONE_DIR"

  if [ "$AGENT_EXIT" -ne 0 ]; then
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: エージェント実行が失敗しました(exit=$AGENT_EXIT)"
    continue
  fi

  ACTUAL_STATUS="$(printf '%s' "$AGENT_OUTPUT" | jq -r '.status' 2>/dev/null || echo "")"
  if [ "$ACTUAL_STATUS" = "$EXPECTED_STATUS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "[$case_name] OK: status=$ACTUAL_STATUS (期待通り)"
  else
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: status=$ACTUAL_STATUS (期待値=$EXPECTED_STATUS)"
  fi
done

echo ""
echo "=== eval-workflow-prompts: $FIXTURE_SET ==="
echo "$PASS_COUNT / $TOTAL 件 合格"
if [ -n "$FAIL_LINES" ]; then
  echo "$FAIL_LINES"
  exit 1
fi
exit 0
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bash scripts/eval-workflow-prompts.test.sh`
Expected: `ALL PASSED`（scenario 1〜5すべてOK）

- [ ] **Step 5: 実行権限を付与する**

```bash
chmod +x scripts/eval-workflow-prompts.sh scripts/eval-workflow-prompts.test.sh
```

- [ ] **Step 6: コミット**

```bash
git add scripts/eval-workflow-prompts.sh scripts/eval-workflow-prompts.test.sh
git commit -m "feat: AIDDワークフロープロンプトのeval実行ハーネス追加(issue #391)"
```

---

### Task 7: npm scriptとドキュメント更新

**Files:**
- Modify: `package.json`
- Modify: `docs/agents/common.md`

- [ ] **Step 1: package.jsonにscriptを追加する**

`package.json` の `"scripts"` セクションに以下を追加（`"loop-summary"` の次の行）:

変更前:
```json
    "loop-summary": "bash scripts/summarize-loop-observability.sh",
    "ai:check": "npm run typecheck && npm run lint && npm run test && npm run test:e2e"
```

変更後:
```json
    "loop-summary": "bash scripts/summarize-loop-observability.sh",
    "eval:workflows": "bash scripts/eval-workflow-prompts.sh",
    "ai:check": "npm run typecheck && npm run lint && npm run test && npm run test:e2e"
```

WHY: `ai:check`には含めない。fixtureの実行は実際に`claude -p`（sonnet）を呼び出すため課金・数分の待ち時間が発生し、通常のtypecheck/lint/test/e2eループに混ぜるとコストが跳ね上がる。`npm run eval:workflows <fixtureセット名>`として独立した手動コマンドにする。

- [ ] **Step 2: docs/agents/common.mdに新セクションを追加する**

`docs/agents/common.md` の「## サブエージェント進捗の可視化（issue #18）」セクション末尾（135行目、「## 引き継ぎフォーマット」の直前）に、新セクションを挿入する。

変更前:
```
    着手する。issue本文に理由を明記済み。

## 引き継ぎフォーマット
```

変更後:
```
    着手する。issue本文に理由を明記済み。

## AIDDワークフロープロンプトのeval（issue #391）

`.claude/workflows/*.js` 内の自然言語プロンプト（例: db-implの「DBスキーマ変更不要ならblockedではなくpass」という判定基準）は、ユニットテストが効かず、修正の妥当性が「次回実フローでの目視確認」頼みになりがちだった（issue #389のフォローアップ）。fixture SPEC.mdを実際のエージェント（`claude -p --agent <agentType>`、本番と同じモデル）に読ませ、期待するstatus判定になるかを回帰テストする仕組みを用意した。

- `npm run eval:workflows <fixtureセット名>`（例: `npm run eval:workflows db-impl`）で実行する。実体は `scripts/eval-workflow-prompts.sh`。
- fixtureは `scripts/eval-fixtures/<name>/` に `manifest.json`（agentType・プロンプトのビルド元モジュール・モデル・出力スキーマ）と `case-*/spec.md` + `case-*/expected.json` を置く形式。db-implには3ケース（①DB変更あり→pass ②「該当なし」明記→pass ③DB言及なし→blocked）を用意済み。将来contract-writer等のプロンプトを追加する場合は `scripts/eval-fixtures/<name>/` を増やすだけでよい。
- 各fixtureはローカルの一時ディレクトリへリポジトリを `git clone --depth 1` してから実行する。本体の `supabase/migrations/` 等を実際に汚さないための隔離（fixture①はマイグレーションファイルを実際に書こうとするため）。
- `claude -p` 呼び出しには `--setting-sources ""` と `--no-session-persistence` を初回コミットから組み込んでいる（verify-claims.shが2026-07-14に経験したStop hook再帰暴走と同型の事故を未然に防ぐため）。同時実行数の上限によるサーキットブレーカーも同様に組み込み済み。
- モデルは意図的に安価なモデルへ差し替えていない（実際のdb-impl実行時と同じsonnet）。安いモデルでevalすると「本番で実際に動くもの」と異なる挙動をテストすることになり、モックが実環境の挙動を隠す典型的な落とし穴に陥るため。
- プロンプト本文のドリフト対策として、db-implプロンプトの正本を `.claude/workflows/lib/prompts/db-impl.js` に切り出し、`aidd-phase2.js` 側のインライン複製との一字一句の一致を `.claude/workflows/lib/__tests__/workflow-prompt-sync.test.js` が機械的に検証する（`npm test`に含まれる）。
- **運用ルール（検知手段なし）**: `.claude/workflows/*.js` のプロンプト文言を変更したPRは、マージ前に `npm run eval:workflows <対応するfixtureセット>` を手動実行することが望ましい。CI化（PR時の自動実行）は実エージェント呼び出しの課金コストを理由に見送った。**この運用ルール自体、実行し忘れても気づく機械的な手段が無い**（下記「検知手段のないルールの棚卸し」参照）。将来案として、`.claude/workflows/*.js` が変更されたPRに対し、evalが最近実行された形跡（タイムスタンプファイル等）の有無だけを軽量にチェックするgit hookを検討したが、今回は見送った。

## 引き継ぎフォーマット
```

- [ ] **Step 3: 「検知手段のないルールの棚卸し」表に行を追加する**

変更前（表の最終行）:
```
| seed・スクリーンショットに実在施設名を使わない | 本ファイル「テスト環境・データ衛生ルール」 | |
```

変更後:
```
| seed・スクリーンショットに実在施設名を使わない | 本ファイル「テスト環境・データ衛生ルール」 | |
| `.claude/workflows/*.js` 変更時の`npm run eval:workflows`手動実行 | 本ファイル「AIDDワークフロープロンプトのeval」 | CI化は実エージェント呼び出しの課金コストで見送り。実行し忘れに気づく手段は無い（issue #391） |
```

- [ ] **Step 4: 「重要ファイルへのパス」表に行を追加する**

変更前（表の最終行）:
```
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
```

変更後:
```
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
```

- [ ] **Step 5: コミット**

```bash
git add package.json docs/agents/common.md
git commit -m "docs: AIDDワークフロープロンプトevalの運用ルールをcommon.mdに追記(issue #391)"
```

---

### Task 8: スモークテスト（実エージェント呼び出し・要ユーザー確認）

**このタスクは実際に`claude -p --agent implementer`をsonnetで3回呼び出すため、実課金・数分の待ち時間が発生する。実行前に必ずユーザーに確認すること。**

**Files:** なし（動作確認のみ）

- [ ] **Step 1: ユーザーに実行してよいか確認する**

「Task 1〜7の実装が完了しました。最後に `npm run eval:workflows db-impl` を実際に実行し、3つのfixtureが期待通りの判定（pass/pass/blocked）になるか確認します。実際に`claude -p --agent implementer`をsonnetで3回呼ぶため課金が発生します。実行してよいですか？」と確認する。

- [ ] **Step 2: 承認後、実行する**

Run: `npm run eval:workflows db-impl`
Expected:
```
[case-1-db-change] OK: status=pass (期待通り)
[case-2-no-db-change] OK: status=pass (期待通り)
[case-3-ambiguous] OK: status=blocked (期待通り)

=== eval-workflow-prompts: db-impl ===
3 / 3 件 合格
```

- [ ] **Step 3: 結果に応じて対応する**

- 全件合格した場合: そのまま完了。特にコミット不要（fixtureの一時clone先は`$CLONE_DIR`で自動削除済み、本体リポジトリに変更は生じない）。
- 不一致があった場合:
  - `--agent implementer`が`--setting-sources ""`と併用したときに正しく`.claude/agents/implementer.md`のシステムプロンプトを読み込めているか（`AGENT_OUTPUT`の内容から、implementer.mdの指示に沿った振る舞いになっているかを確認する）
  - 読み込めていない場合、`--setting-sources ""`を`--setting-sources "project"`に変更する等の対応が必要になる可能性がある（この場合はhooks非継承の安全性とのトレードオフをユーザーと相談する）
  - fixture SPEC.mdの記述が曖昧で意図通りの判定に誘導できていない場合は、fixture本文を調整する

- [ ] **Step 4: 最終確認結果をユーザーに報告する**

引き継ぎフォーマット（`docs/agents/common.md`の「引き継ぎフォーマット」節）に従って報告する。特に「触っていない範囲」（他のfixtureセット・CI統合・fault injection訓練issue #395等）を明記する。

---

## Self-Review メモ

- **spec coverage**: design docの4セクション（正本化/fixture/harness/運用）すべてにタスクが対応している（Task 1-3=正本化、Task 5=fixture、Task 4+6=harness、Task 7=運用ドキュメント）。design docで指摘された2点（変数展開の正規化・運用ルール自体の検知手段の明記）もTask 1/3のコメントとTask 7のcommon.md追記に反映済み。
- **placeholder scan**: 「TODO」「後で実装」等のプレースホルダなし。全ステップに実コードを記載。
- **type consistency**: `buildDbImplPrompt(specPath)` / `extractTemplateLiteralContaining(sourceText, contentMarker)` の関数名・引数名はTask 1-3で一貫。fixtureのJSON形式（`manifest.json`のフィールド名、`expected.json`の`status`キー）もTask 5-6で一貫。
