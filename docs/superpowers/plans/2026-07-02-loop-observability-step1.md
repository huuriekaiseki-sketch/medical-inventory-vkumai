# Loop Observability Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** implementerエージェントの自己修正ループ（RED→GREEN→REFACTOR、失敗時の再試行）が、1試行ごとに `logs/loop-observability.jsonl` へ1レコード書き出すようにする。

**Architecture:** レコード書き込みは実装エージェント自身に文字列組み立てさせず、`scripts/log-loop-observability.sh`（jqでJSONを組み立てるbashスクリプト）に一本化する。implementer.mdはこのスクリプトの呼び出し方だけを指示する。スクリプトはvitestからexecFileSyncで直接叩いてテストする。

**Tech Stack:** Bash + jq（スクリプト本体）、Vitest（スクリプトのテスト、既存の `npm test` に統合）

## Global Constraints

- ログの置き場所は `logs/loop-observability.jsonl`（設計: `docs/superpowers/specs/2026-07-02-loop-observability-design.md`）
- スキーマは `{timestamp, loop, agent, feature, attempt, model, tokens, costUsd, intent, scenario, result, reason}` で固定。`tokens`/`costUsd` は第一段階では常に `null`
- `agent` フィールドの値域: 人間は `"human"` 固定、AIは `.claude/agents/` の定義名（今回は `implementer`）
- `loop` フィールドはこのタスクでは常に `"agentic"`（スクリプト側のデフォルト値とする）

---

## File Structure

- `scripts/log-loop-observability.sh`（新規）— ログ1レコードをjsonlに追記するCLIスクリプト。必須引数の検証・`tokens`/`costUsd`のnull固定・JSON組み立てを担う。
- `src/__tests__/log-loop-observability.test.ts`（新規）— 上記スクリプトをexecFileSyncで実行し、出力されたjsonlの内容を検証する。
- `.gitignore`（修正）— `logs/` を無視対象に追加（ランタイムログをコミットしない）。
- `.claude/agents/implementer.md`（修正）— 自己修正ループの各試行後にスクリプトを呼ぶ指示を追加。

---

### Task 1: ログ記録スクリプトとテストの作成

**Files:**
- Create: `scripts/log-loop-observability.sh`
- Create: `src/__tests__/log-loop-observability.test.ts`
- Modify: `.gitignore`（末尾に追記）

**Interfaces:**
- Produces: `scripts/log-loop-observability.sh` は以下のCLI引数を受け取る実行可能スクリプト
  - 必須: `--agent`, `--feature`, `--attempt`（整数）, `--model`, `--intent`, `--scenario`, `--result`, `--reason`
  - 任意: `--loop`（デフォルト `agentic`）, `--log-file`（デフォルト `logs/loop-observability.jsonl`、テストからは一時ファイルパスを指定する）
  - 出力: `--log-file` で指定したパスに、1行のJSON（`tokens`/`costUsd`は常に`null`）を追記する。ディレクトリが無ければ作成する。
  - 異常系: 必須引数が欠けている場合、`--attempt` が非負整数でない場合は非ゼロ終了コードで終了する。

- [ ] **Step 1: テストディレクトリ構成を確認する**

```bash
ls src/__tests__/ | head -5
```
Expected: 既存のvitestテストファイル一覧が表示される（`log-loop-observability.test.ts` はまだ存在しない）

- [ ] **Step 2: 失敗するテストを書く**

`src/__tests__/log-loop-observability.test.ts` を作成:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'log-loop-observability.sh')

describe('log-loop-observability.sh', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-observability-'))
    logFile = join(dir, 'loop-observability.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]) {
    execFileSync(SCRIPT, args, { encoding: 'utf-8' })
  }

  const baseArgs = (overrides: Record<string, string> = {}) => {
    const defaults: Record<string, string> = {
      '--agent': 'implementer',
      '--feature': 'admin-role',
      '--attempt': '1',
      '--model': 'sonnet',
      '--intent': 'add role field',
      '--scenario': 'unit test for role update',
      '--result': 'pass',
      '--reason': 'test passed on first try',
      '--log-file': logFile,
    }
    const merged = { ...defaults, ...overrides }
    return Object.entries(merged).flatMap(([k, v]) => [k, v])
  }

  it('appends a JSON line with the expected fields', () => {
    run(baseArgs())

    const lines = readFileSync(logFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)

    const record = JSON.parse(lines[0])
    expect(record).toMatchObject({
      loop: 'agentic',
      agent: 'implementer',
      feature: 'admin-role',
      attempt: 1,
      model: 'sonnet',
      tokens: null,
      costUsd: null,
      intent: 'add role field',
      scenario: 'unit test for role update',
      result: 'pass',
      reason: 'test passed on first try',
    })
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('appends multiple attempts as separate lines', () => {
    run(baseArgs({ '--attempt': '1', '--result': 'fail' }))
    run(baseArgs({ '--attempt': '2', '--result': 'pass' }))

    const lines = readFileSync(logFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).attempt).toBe(1)
    expect(JSON.parse(lines[0]).result).toBe('fail')
    expect(JSON.parse(lines[1]).attempt).toBe(2)
    expect(JSON.parse(lines[1]).result).toBe('pass')
  })

  it('rejects a non-integer --attempt', () => {
    expect(() => run(baseArgs({ '--attempt': 'abc' }))).toThrow()
  })

  it('rejects a missing required argument', () => {
    const args = baseArgs()
    const idx = args.indexOf('--reason')
    args.splice(idx, 2)
    expect(() => run(args)).toThrow()
  })

  it('creates the log directory if missing', () => {
    const nestedLogFile = join(dir, 'nested', 'loop-observability.jsonl')
    run(baseArgs({ '--log-file': nestedLogFile }))
    expect(readFileSync(nestedLogFile, 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `npx vitest run src/__tests__/log-loop-observability.test.ts`
Expected: FAIL（`scripts/log-loop-observability.sh` が存在しない、または実行権限がないため `ENOENT` もしくは `EACCES`）

- [ ] **Step 4: スクリプトを実装する**

`scripts/log-loop-observability.sh` を作成:

```bash
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="logs/loop-observability.jsonl"
LOOP="agentic"
AGENT=""
FEATURE=""
ATTEMPT=""
MODEL=""
INTENT=""
SCENARIO=""
RESULT=""
REASON=""

usage() {
  echo "Usage: $0 --agent NAME --feature NAME --attempt N --model NAME --intent TEXT --scenario TEXT --result pass|fail --reason TEXT [--loop agentic|developer|external] [--log-file PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop) LOOP="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --feature) FEATURE="$2"; shift 2 ;;
    --attempt) ATTEMPT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --intent) INTENT="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

for name in AGENT FEATURE ATTEMPT MODEL INTENT SCENARIO RESULT REASON; do
  if [[ -z "${!name}" ]]; then
    echo "Missing required argument: --$(echo "$name" | tr '[:upper:]' '[:lower:]')" >&2
    usage
  fi
done

if ! [[ "$ATTEMPT" =~ ^[0-9]+$ ]]; then
  echo "--attempt must be a non-negative integer" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg loop "$LOOP" \
  --arg agent "$AGENT" \
  --arg feature "$FEATURE" \
  --argjson attempt "$ATTEMPT" \
  --arg model "$MODEL" \
  --arg intent "$INTENT" \
  --arg scenario "$SCENARIO" \
  --arg result "$RESULT" \
  --arg reason "$REASON" \
  '{timestamp: $timestamp, loop: $loop, agent: $agent, feature: $feature, attempt: $attempt, model: $model, tokens: null, costUsd: null, intent: $intent, scenario: $scenario, result: $result, reason: $reason}' \
  >> "$LOG_FILE"
```

実行権限を付与する:

```bash
chmod +x scripts/log-loop-observability.sh
```

- [ ] **Step 5: `.gitignore` にログディレクトリを追加する**

`.gitignore` の末尾（`e2e/.auth/user.json` の後）に追記:

```
# loop observability
/logs/
```

- [ ] **Step 6: テストを実行して成功を確認する**

Run: `npx vitest run src/__tests__/log-loop-observability.test.ts`
Expected: PASS（5テストすべて成功）

- [ ] **Step 7: プロジェクト全体のテストとlintを実行する**

Run: `npm test && npm run lint`
Expected: 既存テストを含めすべてPASS、lintエラーなし

- [ ] **Step 8: コミット**

```bash
git add scripts/log-loop-observability.sh src/__tests__/log-loop-observability.test.ts .gitignore
git commit -m "feat: loop observabilityログ記録スクリプトを追加"
```

---

### Task 2: implementer.mdへのログ記録指示追加

**Files:**
- Modify: `.claude/agents/implementer.md:12-17`（「実装セットの進め方」節）

**Interfaces:**
- Consumes: Task 1で作成した `scripts/log-loop-observability.sh`（CLI引数は上記Interfaces参照）
- Produces: なし（プロンプト指示のみ。後続タスクはない）

- [ ] **Step 1: 現在の内容を確認する**

```bash
cat -n .claude/agents/implementer.md
```
Expected: 12〜17行目に「実装セットの進め方（RED → GREEN → REFACTOR）」の5ステップが表示される

- [ ] **Step 2: ログ記録セクションを追加する**

`.claude/agents/implementer.md` の「## 実装セットの進め方（RED → GREEN → REFACTOR）」セクション（12〜17行目）の直後、「## 絶対にやってはいけないこと」セクションの直前に以下を挿入:

```markdown
## 自己修正ループのログ記録
実装セットごとに、テストを実行するたびに `scripts/log-loop-observability.sh` を呼び出し、1回の試行につき1レコードを記録すること。「実装セットの進め方」のステップ4（テスト通過を確認）とステップ5（自己修正の再試行）の両方で、テストを実行した直後に呼ぶ。

例（1回目のテストが失敗し、2回目の修正で通った場合）:
\`\`\`bash
scripts/log-loop-observability.sh \
  --agent implementer \
  --feature "<SPEC.mdのタスク名>" \
  --attempt 1 \
  --model sonnet \
  --intent "<何を実装しようとしたか、1文>" \
  --scenario "<実行したテストの内容、1文>" \
  --result fail \
  --reason "<失敗理由、1文>"

scripts/log-loop-observability.sh \
  --agent implementer \
  --feature "<SPEC.mdのタスク名>" \
  --attempt 2 \
  --model sonnet \
  --intent "<何を実装しようとしたか、1文>" \
  --scenario "<実行したテストの内容、1文>" \
  --result pass \
  --reason "<通った理由、1文>"
\`\`\`

- `--model` には自分が実行されているモデル名（例: `sonnet`、`opus`）を書く。
- 3回修正しても通らず人間に報告する場合も、3回目の試行として `--result fail` を記録してから報告すること。
```

- [ ] **Step 3: 挿入内容を確認する**

```bash
grep -n "自己修正ループのログ記録" .claude/agents/implementer.md
```
Expected: 該当行番号が1件表示される

- [ ] **Step 4: コミット**

```bash
git add .claude/agents/implementer.md
git commit -m "docs: implementer.mdに自己修正ループのログ記録指示を追加"
```

---

## Self-Review（実施済み）

1. **仕様網羅性:** 設計ドキュメントのStep 1範囲（implementer.mdへのレコード書き出し指示追加、`model`含む）はTask 1（スクリプト）+ Task 2（指示追加）でカバー。`tokens`/`costUsd`は常にnullで固定 — スクリプトのjqテンプレートに直書きし、CLI引数に露出させないことで「第一段階では自己申告させない」設計判断を強制。
2. **プレースホルダー:** なし。全ステップに実コード・実コマンドを記載。
3. **型/インターフェース一貫性:** スクリプトのCLI引数名（`--agent`/`--feature`/`--attempt`/`--model`/`--intent`/`--scenario`/`--result`/`--reason`/`--loop`/`--log-file`）はTask 1のテストとTask 2のimplementer.md指示例で一致。
