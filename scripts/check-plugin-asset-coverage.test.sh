#!/usr/bin/env bash
# WHY: **検査（*.test.sh）には層の表の網羅検査があったのに、agent / skill / workflow には無かった。**
#      `scripts/lib/build-plugin.mjs` は層の表（plugin-layout.json）を**回るだけ**で、
#      `.claude/agents/` にファイルがあっても表に無ければ**黙って配らない**。
#
#      2026-09-11 に実際に空いた: `proposer` が Claude 側では `~/.claude/agents/`（グローバル）に
#      しか無く、リポジトリへ持ってきたときに層の表へ足し忘れた。配布物には入らないので、
#      **派生先では proposer だけが存在しないまま**になる。この形は気づけない——
#      ビルドは成功し、検査は緑で、足りないことは配った先で初めて分かる。
#
#      **hook だけは最初から両方向だった**（`build-plugin.mjs` の
#      「settings.json に登録された hook が層の表に無い」「層の表の hook が settings.json に無い」）。
#      つまり書いた本人は両方向の必要性を知っていて、隣の 3 種類へ広げなかっただけ。型は C-047。
#
#      同じ形の見落としは skill / workflow でも起きるので、3 種類まとめて両方向で突き合わせる:
#   (a) `.claude/agents/*.md`・`.claude/skills/*/`・`.claude/workflows/*.js` の実体がすべて
#       層の表（agents / skills / workflows）か、配らない表（*NotDistributed）に載っている
#   (b) 層の表に、実体の無い行が残っていない（消したら表からも消す）
#   (c) 配らない表の理由が空でない（「面倒だから」は理由にしない）
#   (d) 走査が空振りしていない（表に行があるのに実体を 1 件も拾えないのは走査の故障。C-044）
#   (e) fixture で (a)〜(d) を検知できる（RED 方向の自己検証。C-022）
#
# 限界:
#   - **層の表に載っていること**しか見ない。載っている先のプラグイン名が妥当か（共通側に
#     固有のものを入れていないか）は見ない——それは build-plugin の禁止語検査の担当。
#   - 見るのは agent / skill / workflow の 3 種類だけ。**`scripts/` の非テストスクリプトには
#     同じ門が無い**（`*.test.sh` は `check-plugin-check-coverage.test.sh` が見る）。
#     支援スクリプトは「表に無い＝配らない」が既定で、その判断が記録に残らないまま増えている。
#     数えるなら `hookScripts`+`supportScripts`+`bin`+`workflowLib` と実体の差を取る。
#   - skill は**ディレクトリの有無**しか見ない。中身（SKILL.md があるか）は見ない。
#
# 実行: bash scripts/check-plugin-asset-coverage.test.sh
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
find_uncovered() {
  node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const layoutPath = path.join(root, "scripts/lib/plugin-layout.json")
if (!fs.existsSync(layoutPath)) { console.log("layout: scripts/lib/plugin-layout.json が無い"); process.exit(0) }
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"))

const listDir = (rel) => {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true })
}
// 実体の集め方は build-plugin.mjs の写し方に合わせる
// （agents=.md 1 枚 / skills=ディレクトリ / workflows=直下の .js。lib・__fixtures__ 等の下請けは資産ではない）
const onDisk = {
  agents: listDir(".claude/agents").filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name.slice(0, -3)),
  skills: listDir(".claude/skills").filter((d) => d.isDirectory()).map((d) => d.name),
  workflows: listDir(".claude/workflows").filter((d) => d.isFile() && d.name.endsWith(".js")).map((d) => d.name.slice(0, -3)),
}
const exists = {
  agents: (n) => fs.existsSync(path.join(root, ".claude/agents", n + ".md")),
  skills: (n) => fs.existsSync(path.join(root, ".claude/skills", n)),
  workflows: (n) => fs.existsSync(path.join(root, ".claude/workflows", n + ".js")),
}

for (const kind of ["agents", "skills", "workflows"]) {
  const declared = Object.keys(layout[kind] ?? {}).filter((k) => !k.startsWith("_"))
  const notDistributed = Object.entries(layout[kind + "NotDistributed"] ?? {}).filter(([k]) => !k.startsWith("_"))
  const notDistributedNames = new Set(notDistributed.map(([k]) => k))
  const covered = new Set([...declared, ...notDistributedNames])

  // (d) 空振り防止: 表に行があるのに実体が 1 件も無いのは、走査が壊れているほうを疑う。
  //     表も実体も空なら、その種類を使っていない導入先なので黙る
  if (covered.size > 0 && onDisk[kind].length === 0) {
    console.log(`empty-scan: ${kind}（層の表に ${covered.size} 行あるのに実体を 1 件も拾えない）`)
    continue
  }

  // (a) 実体があるのに層が決まっていない＝**黙って配られない**
  for (const name of onDisk[kind].sort()) {
    if (!covered.has(name)) {
      console.log(`uncovered: ${kind}/${name}（層の表 ${kind} にも ${kind}NotDistributed にも無い＝配布物に入らない）`)
    }
  }
  // (b) 表に残った幽霊
  for (const name of [...covered].sort()) {
    if (!exists[kind](name)) console.log(`stale: ${kind}/${name}（実体が無いのに層の表に残っている）`)
  }
  // (c) 配らない理由が空
  for (const [name, reason] of notDistributed) {
    if (!String(reason ?? "").trim()) console.log(`no-reason: ${kind}/${name}（配らない理由が空）`)
  }
}
' "$1"
}

echo "=== scenario 1: 実態の agent / skill / workflow がすべて層を持つ ==="
OUT="$(find_uncovered "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "未分類・幽霊・理由なし・空振り いずれも 0 件"
else
  assert_fail "資産の層が決まっていない" "$OUT
      直し方: scripts/lib/plugin-layout.json の agents / skills / workflows に層を書くか、
      配らないなら <種類>NotDistributed に理由を書く"
fi

echo "=== scenario 2: 走査が実体を拾えている（空振り防止。C-044） ==="
# WHY: 違反が 0 件のとき、それが「本当に 0 件」なのか「走査が何も見ていない」のか
#      scenario 1 だけでは区別できない。実体の件数を別に数えて確かめる
COUNT_AGENTS="$(ls "$REPO_ROOT/.claude/agents"/*.md 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT_AGENTS" -ge 1 ]; then
  assert_ok "agent の実体を $COUNT_AGENTS 本拾えている"
else
  assert_fail "agent の実体が 1 本も無い" "走査の前提が崩れている（scenario 1 の緑は空振りの可能性）"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts/lib" "$WORK/.claude/agents" "$WORK/.claude/skills/skill-known" "$WORK/.claude/workflows/lib"

cat > "$WORK/scripts/lib/plugin-layout.json" <<'EOF'
{
  "agents": { "agent-known": "aidd-core", "agent-ghost": "aidd-core" },
  "agentsNotDistributed": { "agent-local": "" },
  "skills": { "skill-known": "aidd-core" },
  "workflows": { "wf-known": "aidd-core" }
}
EOF
printf -- '---\nname: agent-known\n---\n本文\n' > "$WORK/.claude/agents/agent-known.md"
printf -- '---\nname: agent-local\n---\n本文\n' > "$WORK/.claude/agents/agent-local.md"
printf -- '---\nname: agent-forgotten\n---\n本文\n' > "$WORK/.claude/agents/agent-forgotten.md"
printf -- '# skill\n' > "$WORK/.claude/skills/skill-known/SKILL.md"
printf -- 'export const meta = {}\n' > "$WORK/.claude/workflows/wf-known.js"
printf -- 'export const meta = {}\n' > "$WORK/.claude/workflows/wf-forgotten.js"
printf -- 'export const helper = 1\n' > "$WORK/.claude/workflows/lib/router-risk.js"

OUT="$(find_uncovered "$WORK")"
if printf '%s\n' "$OUT" | grep -q 'uncovered: agents/agent-forgotten'; then
  assert_ok "層を決めていない agent を検知"
else
  assert_fail "未分類の agent を検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'uncovered: workflows/wf-forgotten'; then
  assert_ok "層を決めていない workflow を検知"
else
  assert_fail "未分類の workflow を検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'stale: agents/agent-ghost'; then
  assert_ok "実体の無い行が表に残っているのを検知"
else
  assert_fail "幽霊エントリを検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'no-reason: agents/agent-local'; then
  assert_ok "配らない理由が空なのを検知"
else
  assert_fail "理由なしを検知できない" "$OUT"
fi
# 誤検知しない側（対を置く。C-021）
if printf '%s\n' "$OUT" | grep -q 'agents/agent-known'; then
  assert_fail "層の表にある agent を誤検知した" "$OUT"
else
  assert_ok "表にある agent は通る"
fi
if printf '%s\n' "$OUT" | grep -q 'agents/agent-local（層の表'; then
  assert_fail "配らないと決めた agent を未分類と誤検知した" "$OUT"
else
  assert_ok "配らないと決めた agent は未分類にしない"
fi
if printf '%s\n' "$OUT" | grep -q 'router-risk'; then
  assert_fail "workflows/lib/ の下請けを資産と誤検知した" "$OUT"
else
  assert_ok "workflows/lib/ の下請けは数えない"
fi
if printf '%s\n' "$OUT" | grep -q 'skills/'; then
  assert_fail "そろっている skill を誤検知した" "$OUT"
else
  assert_ok "そろっている skill は通る"
fi

echo "=== scenario 4: 表に行があるのに実体が拾えない＝走査の故障として落ちる ==="
# WHY: ディレクトリ名を間違える・拡張子を変えるなどで走査が空になったとき、
#      「違反 0 件」と読めてしまうのがいちばん危ない（C-044）
WORK2="$WORK/fx2"
mkdir -p "$WORK2/scripts/lib"
cat > "$WORK2/scripts/lib/plugin-layout.json" <<'EOF'
{
  "agents": { "agent-known": "aidd-core" },
  "skills": {},
  "workflows": {}
}
EOF
OUT2="$(find_uncovered "$WORK2")"
if printf '%s\n' "$OUT2" | grep -q 'empty-scan: agents'; then
  assert_ok "実体を拾えないのを走査の故障として検知"
else
  assert_fail "空振りを検知できない" "$OUT2"
fi

echo "=== scenario 5: その種類を使っていない導入先では黙る ==="
# WHY: 表も実体も空なら、それは「使っていない」だけで違反ではない。
#      ここで鳴ると導入先で毎回赤くなり、検査ごと無視されるようになる
WORK3="$WORK/fx3"
mkdir -p "$WORK3/scripts/lib"
cat > "$WORK3/scripts/lib/plugin-layout.json" <<'EOF'
{ "agents": {}, "skills": {}, "workflows": {} }
EOF
OUT3="$(find_uncovered "$WORK3")"
if [ -z "$OUT3" ]; then
  assert_ok "agent も skill も workflow も無い導入先では何も言わない"
else
  assert_fail "使っていない種類で誤検知した" "$OUT3"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
