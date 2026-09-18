#!/usr/bin/env bash
# WHY: **進捗記録の対象一覧が、一覧しか見ていなかった**（C-011）。
#      `.claude/workflows/lib/__tests__/agent-progress-expectation.test.js` は
#      「12 個の名前が集合に入っているか」を確かめるだけで、**その名前の agent が本当に
#      記録できるか**は誰も見ていなかった。
#
#      2026-09-11 に実際に食い違っていた: `proposer` は一覧に入っているのに
#      **`tools: Read` だけで `log-agent-progress.sh` を呼べない**（12 体のうち指示を持つのは 11 体）。
#      一覧は「期待される記録件数」として gap check に使われるので、**呼べない agent が混ざると
#      期待だけが増えて毎回「記録漏れ」と鳴る**。鳴り続ける警告は読まれなくなる。
#
#   (a) 一覧の全員に `.claude/agents/<name>.md` が実在する
#   (b) その本文に `log-agent-progress.sh` の呼び出し指示がある
#   (c) その `tools:` に Bash がある（無ければ**構造的に**呼べない。指示だけあっても意味が無い）
#   (d) 逆向き: 指示を持つ agent が一覧に入っている（記録しても期待件数に入らない状態を作らない）
#   (e) 書き込みツール（Edit / Write）を持たず Bash を持つ agent は
#       `aidd.config.json` の `readonlyAgentTypes` に入っている（Bash の deny 対象になっている）
#   (f) 一覧の**3 つの複製**が一致する。`agent-progress-expectation.js`（正本）／
#       `aidd-phase2.js`（Workflow DSL は require できないので手で写している）／
#       `scripts/lib/canonical-event.ts` の `KNOWN_AGENT_TYPES`（観測の復元に使う TS 側）。
#       **どれにも同期テストが無かった。**
#   (g) 一覧が 1 件も読めなかったら落とす（走査の故障を「違反 0 件」と読まない。C-044）
#   (h) fixture で (a)〜(g) を検知できる（RED 方向の自己検証。C-022）
#
# 限界:
#   - 本文に**指示があること**しか見ない。agent が実際に呼ぶかは見ない
#     （それは `scripts/verify-agent-progress-transcript.sh` が transcript と突き合わせる担当）。
#   - `tools:` は frontmatter の 1 行を読むだけ。継承や既定値は考えない。
#   - (e) の判定材料は tools だけ。「読み取り専用」と本文に書いてあるかは見ない。
#
# 実行: bash scripts/check-agent-progress-instructions.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=リポジトリルート。違反を 1 行ずつ出す（違反が無ければ何も出さない）
find_mismatches() {
  node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]

const EXPECT = path.join(root, ".claude/workflows/lib/agent-progress-expectation.js")
const PHASE2 = path.join(root, ".claude/workflows/aidd-phase2.js")
const CANONICAL = path.join(root, "scripts/lib/canonical-event.ts")
// issue #797 で 4 つ目の複製ができた（deep ルートが期待件数を返せるようになった）
const DEEPTASK = path.join(root, ".claude/workflows/aidd-1-1-deep-task.js")
const AGENTS = path.join(root, ".claude/agents")
const CONFIG = path.join(root, "aidd.config.json")

/** 一覧の中の文字列を取り出す（`= new Set([...])` / `= [...] as const` のどちらも） */
function readList(file, varName) {
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, "utf8")
  const re = new RegExp(varName + "\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]")
  const m = src.match(re)
  if (!m) return null
  const names = [...m[1].matchAll(/[\x27"]([\w-]+)[\x27"]/g)].map((x) => x[1])
  return names.length > 0 ? names : null
}

// WHY(この仕組みを持たない導入先): 一覧が無ければ (a)〜(d)(f)(g) は判定する対象が無いので飛ばす。
//      ただし **(e)（読み取り専用の agent が Bash の deny 対象に入っているか）は一覧に依存しない**ので、
//      一覧が無い導入先でも必ず回す。ここで丸ごと降りると、配った先で永久に何も見ない検査になる
const hasList = fs.existsSync(EXPECT)
let listed = null
if (hasList) {
  listed = readList(EXPECT, "PROGRESS_LOGGABLE_AGENT_TYPES")
  // (g) 走査の故障を「違反 0 件」と読まない
  if (!listed) console.log("parse-failed: agent-progress-expectation.js から一覧を読めなかった")
}

// (f) 一覧の複製が一致する。**4 か所ある**——
//     Workflow DSL は require できないので aidd-phase2.js と aidd-1-1-deep-task.js が手で写し、
//     観測の復元（canonical-event.ts）は TS 側なのでさらにもう 1 つ持っている。
//     deep ルート側は issue #797 で増えた（それまで期待件数を返せていなかった）
const copies = [
  [PHASE2, "PROGRESS_LOGGABLE_AGENT_TYPES", "phase2"],
  [DEEPTASK, "PROGRESS_LOGGABLE_AGENT_TYPES", "deep-task"],
  [CANONICAL, "KNOWN_AGENT_TYPES", "canonical-event"],
]
if (listed) {
  const a = [...listed].sort().join(",")
  for (const [file, varName, label] of copies) {
    if (!fs.existsSync(file)) continue
    const copy = readList(file, varName)
    if (!copy) { console.log(`parse-failed: ${label} の複製から一覧を読めなかった`); continue }
    const b = [...copy].sort().join(",")
    if (a !== b) console.log(`list-drift: 一覧の複製が食い違う（expectation=[${a}] ${label}=[${b}]）`)
  }
}

/** frontmatter の tools: 行 */
function toolsOf(body) {
  const m = body.match(/^tools:\s*(.+)$/m)
  return m ? m[1] : ""
}
const hasInstruction = (body) => body.includes("log-agent-progress.sh")
const hasBash = (tools) => /\bBash\b/.test(tools)
const hasWrite = (tools) => /\b(Edit|Write|MultiEdit)\b/.test(tools)

const onDisk = fs.existsSync(AGENTS)
  ? fs.readdirSync(AGENTS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
  : []
if (onDisk.length === 0) { console.log("empty-scan: .claude/agents/ から agent を 1 件も拾えない"); process.exit(0) }

const bodyOf = (name) => fs.readFileSync(path.join(AGENTS, name + ".md"), "utf8")

if (listed) {
  const listedSet = new Set(listed)
  for (const name of [...listed].sort()) {
    if (!onDisk.includes(name)) { console.log(`missing-md: ${name}（一覧にあるが .claude/agents/${name}.md が無い）`); continue }
    const body = bodyOf(name)
    if (!hasInstruction(body)) console.log(`no-instruction: ${name}（一覧にあるが log-agent-progress.sh の呼び出し指示が本文に無い）`)
    if (!hasBash(toolsOf(body))) console.log(`no-bash: ${name}（一覧にあるが tools に Bash が無い＝構造的に呼べない）`)
  }
  // (d) 逆向き
  for (const name of onDisk.sort()) {
    const body = bodyOf(name)
    if (hasInstruction(body) && !listedSet.has(name)) {
      console.log(`not-listed: ${name}（記録の指示を持つのに一覧に無い＝記録しても期待件数に入らない）`)
    }
  }
}

// (e) 読み取り専用（Bash はあるが Edit / Write は無い）なら Bash の deny 対象に入っている
let readonlyTypes = null
if (fs.existsSync(CONFIG)) {
  try { readonlyTypes = new Set(JSON.parse(fs.readFileSync(CONFIG, "utf8")).readonlyAgentTypes ?? []) } catch { readonlyTypes = null }
}
if (readonlyTypes) {
  for (const name of onDisk.sort()) {
    const tools = toolsOf(bodyOf(name))
    if (hasBash(tools) && !hasWrite(tools) && !readonlyTypes.has(name)) {
      console.log(`not-readonly-guarded: ${name}（Edit / Write を持たず Bash を持つのに readonlyAgentTypes に無い）`)
    }
  }
}
' "$1"
}

echo "=== scenario 1: 実態の一覧と agent 定義が食い違っていない ==="
OUT="$(find_mismatches "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "一覧・指示・tools・deny 対象 いずれも食い違い 0 件"
else
  assert_fail "進捗記録の宣言と実体が食い違っている" "$OUT
      直し方: 記録させるなら agent の tools に Bash を足して「## 進捗報告」の節を書く。
      記録させないなら一覧（agent-progress-expectation.js と aidd-phase2.js の両方）から外す"
fi

echo "=== scenario 2: 走査が実体を拾えている（空振り防止。C-044） ==="
# WHY: 違反 0 件が「本当に 0 件」なのか「一覧も agent も読めていない」のか、
#      scenario 1 だけでは区別できない
COUNT="$(ls "$REPO_ROOT/.claude/agents"/*.md 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -ge 1 ]; then
  assert_ok "agent の実体を $COUNT 本拾えている"
else
  assert_fail "agent の実体が 1 本も無い" "走査の前提が崩れている"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.claude/workflows/lib" "$WORK/.claude/agents"

cat > "$WORK/.claude/workflows/lib/agent-progress-expectation.js" <<'EOF'
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set([
  'agent-ok',
  'agent-no-bash',
  'agent-no-instruction',
  'agent-gone',
])
EOF
cat > "$WORK/aidd.config.json" <<'EOF'
{ "readonlyAgentTypes": ["agent-ok"] }
EOF
printf -- '---\nname: agent-ok\ntools: Read, Bash\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK/.claude/agents/agent-ok.md"
printf -- '---\nname: agent-no-bash\ntools: Read\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK/.claude/agents/agent-no-bash.md"
printf -- '---\nname: agent-no-instruction\ntools: Read, Bash\n---\n本文だけ\n' > "$WORK/.claude/agents/agent-no-instruction.md"
printf -- '---\nname: agent-unlisted\ntools: Read, Bash\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK/.claude/agents/agent-unlisted.md"
printf -- '---\nname: agent-writer\ntools: Read, Edit, Write, Bash\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK/.claude/agents/agent-writer.md"

OUT="$(find_mismatches "$WORK")"
if grep -q 'missing-md: agent-gone' <<<"$OUT"; then
  assert_ok "一覧にあるが定義が無いのを検知"
else
  assert_fail "定義の欠落を検知できない" "$OUT"
fi
if grep -q 'no-bash: agent-no-bash' <<<"$OUT"; then
  assert_ok "Bash が無く構造的に呼べないのを検知"
else
  assert_fail "Bash の欠落を検知できない" "$OUT"
fi
if grep -q 'no-instruction: agent-no-instruction' <<<"$OUT"; then
  assert_ok "呼び出し指示が無いのを検知"
else
  assert_fail "指示の欠落を検知できない" "$OUT"
fi
if grep -q 'not-listed: agent-unlisted' <<<"$OUT"; then
  assert_ok "指示を持つのに一覧に無いのを検知（逆向き）"
else
  assert_fail "逆向きを検知できない" "$OUT"
fi
if grep -q 'not-readonly-guarded: agent-unlisted' <<<"$OUT"; then
  assert_ok "読み取り専用なのに Bash の deny 対象でないのを検知"
else
  assert_fail "deny 対象の漏れを検知できない" "$OUT"
fi
# 誤検知しない側（対を置く。C-021）
if grep -q 'agent-ok' <<<"$OUT"; then
  assert_fail "そろっている agent を誤検知した" "$OUT"
else
  assert_ok "そろっている agent は通る"
fi
if grep -q 'not-readonly-guarded: agent-writer' <<<"$OUT"; then
  assert_fail "書き込みツールを持つ agent を deny 対象漏れと誤検知した" "$OUT"
else
  assert_ok "書き込みツールを持つ agent は deny 対象に入れない"
fi

echo "=== scenario 4: 一覧の 4 つの複製が食い違ったら落ちる ==="
# WHY: Workflow DSL は require できないので aidd-phase2.js が同じ集合をインラインで持ち、
#      観測の復元（canonical-event.ts）はさらにもう 1 つ持っている。
#      複製は必ずずれるのに、どれにも同期テストが無かった
WORK2="$WORK/fx2"
mkdir -p "$WORK2/.claude/workflows/lib" "$WORK2/.claude/agents" "$WORK2/scripts/lib"
cat > "$WORK2/.claude/workflows/lib/agent-progress-expectation.js" <<'EOF'
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set(['agent-ok', 'agent-extra'])
EOF
cat > "$WORK2/.claude/workflows/aidd-phase2.js" <<'EOF'
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set(['agent-ok'])
EOF
cat > "$WORK2/scripts/lib/canonical-event.ts" <<'EOF'
export const KNOWN_AGENT_TYPES = ['agent-ok', 'agent-extra', 'agent-ghost'] as const
EOF
printf -- '---\nname: agent-ok\ntools: Read, Bash\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK2/.claude/agents/agent-ok.md"
printf -- '---\nname: agent-extra\ntools: Read, Bash\n---\nscripts/log-agent-progress.sh を呼ぶ\n' > "$WORK2/.claude/agents/agent-extra.md"

OUT2="$(find_mismatches "$WORK2")"
if grep -q 'list-drift: 一覧の複製が食い違う（expectation=\[agent-extra,agent-ok\] phase2=' <<<"$OUT2"; then
  assert_ok "Workflow 側の複製のずれを検知"
else
  assert_fail "Workflow 側の複製のずれを検知できない" "$OUT2"
fi
if grep -q 'canonical-event=\[agent-extra,agent-ghost,agent-ok\]' <<<"$OUT2"; then
  assert_ok "TS 側（canonical-event.ts）の複製のずれも検知"
else
  assert_fail "TS 側の複製のずれを検知できない" "$OUT2"
fi

echo "=== scenario 5: 一覧を読めなかったら落ちる（fail-open 防止） ==="
WORK3="$WORK/fx3"
mkdir -p "$WORK3/.claude/workflows/lib" "$WORK3/.claude/agents"
printf -- 'export function isProgressLoggableAgentType() { return false }\n' > "$WORK3/.claude/workflows/lib/agent-progress-expectation.js"
printf -- '---\nname: agent-ok\ntools: Read, Bash\n---\n本文\n' > "$WORK3/.claude/agents/agent-ok.md"
OUT3="$(find_mismatches "$WORK3")"
if grep -q 'parse-failed:' <<<"$OUT3"; then
  assert_ok "一覧を読めないのを違反として扱う"
else
  assert_fail "読めないのを黙って通した" "$OUT3"
fi

echo "=== scenario 6: この仕組みを持たない導入先では、一覧の判定だけを飛ばす ==="
# WHY: 一覧が無いからといって丸ごと降りると、配った先で**永久に何も見ない検査**になる。
#      一覧に依存しない (e)（読み取り専用の agent が Bash の deny 対象か）は必ず回す
WORK4="$WORK/fx4"
mkdir -p "$WORK4/.claude/agents"
printf -- '---\nname: agent-ok\ntools: Read\n---\n本文\n' > "$WORK4/.claude/agents/agent-ok.md"
OUT4="$(find_mismatches "$WORK4")"
if [ -z "$OUT4" ]; then
  assert_ok "一覧を持たない導入先では一覧の判定を出さない"
else
  assert_fail "仕組みを持たない導入先で誤検知した" "$OUT4"
fi

WORK5="$WORK/fx5"
mkdir -p "$WORK5/.claude/agents"
cat > "$WORK5/aidd.config.json" <<'EOF'
{ "readonlyAgentTypes": [] }
EOF
printf -- '---\nname: agent-ro\ntools: Read, Bash\n---\n本文\n' > "$WORK5/.claude/agents/agent-ro.md"
OUT5="$(find_mismatches "$WORK5")"
if grep -q 'not-readonly-guarded: agent-ro' <<<"$OUT5"; then
  assert_ok "一覧が無くても deny 対象の漏れは見る"
else
  assert_fail "一覧が無いと丸ごと降りている（配った先で何も見ない検査になる）" "$OUT5"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
