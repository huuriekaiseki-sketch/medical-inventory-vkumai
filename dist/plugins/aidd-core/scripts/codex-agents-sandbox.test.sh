#!/usr/bin/env bash
# WHY: Codex subagent（`.codex/agents/*.toml`）の sandbox_mode 明示を機械強制する。
#      sandbox_mode を書かないと親セッションの権限（workspace-write 等）を継承し、
#      レビュー専用・読み取り専用のはずの subagent が**書き込み可能になる**（riff-gear 実機検証）。
#      テンプレート原則 6: 全 toml が sandbox_mode を明示し、読み取り専用ロールは read-only とする。
#
#      **2026-09-11: ロール名のハードコードをやめた。** それまで
#      `READONLY_ROLES="reviewer sweep-ui sweep-data …"` と 12 個の名前を直接書いていたが、
#      **この検査は共通側（aidd-core）として配られる**。導入先の agent 構成は違うので、
#      配った先では「自分のリポジトリに無いロールの toml が存在しない」で必ず落ちる——
#      止める仕組みを配ったつもりで、**赤くなるだけの検査**を配っていた。
#
#      いまは `.claude/agents/*.md` の `tools:` から導く（Edit / Write があれば workspace-write、
#      無ければ read-only）。規則の正本は `scripts/lib/generate-codex-agents.mjs` の
#      `sandboxModeFor` で、**そこから import する**（写すとずれるため）。
#
#      ハードコードが実際にずれていた例: この一覧は `proposer` を読み取り専用として持っていたのに、
#      `aidd.config.json` の `readonlyAgentTypes` には入っていなかった（E-025）。
#      **どちらが正しいか、名前の一覧同士では決められない。**
#
#   (a) 全 toml が sandbox_mode を明示している（暗黙の権限継承を許さない）
#   (b) その値が、対応する md の `tools:` から決まる値と一致する
#   (c) Codex を使わない導入先では黙る。**toml があるのに正本を 1 件も拾えなければ落とす**（C-044）
#   (d) fixture で (a)(b) を検知できる（RED 方向の自己検証。C-022）
#
# 限界:
#   - `tools:` は frontmatter の 1 行を読むだけ。継承や既定値は考えない。
#   - 見るのは sandbox_mode の**値**だけ。Codex が実際にその権限で動くかは実機検証の担当
#     （`docs/agents/claude-codex-coexistence-template.md`「実機検証手順」）。
#
# 実行: bash scripts/codex-agents-sandbox.test.sh
# 環境変数（テスト用注入ポイント）: CODEX_SANDBOX_ROOT
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/lib/generate-codex-agents.mjs"
REPO_ROOT="${CODEX_SANDBOX_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=リポジトリルート。違反を 1 行ずつ出す（違反が無ければ何も出さない）
find_sandbox_mismatches() {
  node -e '
const fs = require("fs")
const path = require("path")
const url = require("url")
const root = process.argv[1]
const engine = process.argv[2]
const CODEX = path.join(root, ".codex/agents")
const CLAUDE = path.join(root, ".claude/agents")

const tomls = fs.existsSync(CODEX)
  ? fs.readdirSync(CODEX).filter((f) => f.endsWith(".toml")).sort()
  : []
// Codex を使わない導入先では黙る（判定する対象が無い）
if (tomls.length === 0) process.exit(0)

import(url.pathToFileURL(engine).href).then(({ sandboxModeFor }) => {
  if (typeof sandboxModeFor !== "function") {
    console.log("engine-missing: sandboxModeFor を読み込めなかった（判定の正本が無い）")
    return
  }
  const mds = fs.existsSync(CLAUDE)
    ? fs.readdirSync(CLAUDE).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
    : []
  // (c) 走査の故障を「違反 0 件」と読まない
  if (mds.length === 0) {
    console.log(`empty-scan: .codex/agents に ${tomls.length} 本あるのに .claude/agents から正本を 1 件も拾えない`)
    return
  }
  for (const t of tomls) {
    const name = t.slice(0, -5)
    const body = fs.readFileSync(path.join(CODEX, t), "utf8")
    const declared = body.match(/^sandbox_mode\s*=\s*"([^"]+)"/m)
    if (!declared) { console.log(`no-sandbox-mode: ${t}（親権限を暗黙継承してしまう）`); continue }
    if (!mds.includes(name)) {
      console.log(`no-source: ${t}（正本 .claude/agents/${name}.md が無いので期待値を決められない）`)
      continue
    }
    const md = fs.readFileSync(path.join(CLAUDE, name + ".md"), "utf8")
    const m = md.match(/^tools:\s*(.+)$/m)
    const expected = sandboxModeFor(m ? m[1] : "")
    if (declared[1] !== expected) {
      console.log(`sandbox-mismatch: ${t}（toml=${declared[1]} だが tools から決まるのは ${expected}）`)
    }
  }
}).catch((e) => {
  console.log(`engine-load-failed: ${e.message}`)
})
' "$1" "$ENGINE"
}

echo "=== scenario 1: 実態の toml が sandbox_mode を明示し、tools から決まる値と一致する ==="
OUT="$(find_sandbox_mismatches "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "明示漏れ・食い違い・正本なし いずれも 0 件"
else
  assert_fail "sandbox_mode が実態と食い違う" "$OUT
      直し方: node scripts/lib/generate-codex-agents.mjs --write で toml を作り直すか、
      md 側の tools を直す（権限を変えるなら人が判断する）"
fi

echo "=== scenario 2: 走査が実体を拾えている（空振り防止。C-044） ==="
COUNT="$(ls "$REPO_ROOT/.codex/agents"/*.toml 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -ge 1 ]; then
  assert_ok "Codex の agent を $COUNT 本拾えている"
else
  assert_fail "Codex の agent が 1 本も無い" "走査の前提が崩れている"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.codex/agents" "$WORK/.claude/agents"

mk() { # $1=name $2=tools $3=sandbox 行（空なら書かない）
  printf -- '---\nname: %s\ntools: %s\n---\n本文\n' "$1" "$2" > "$WORK/.claude/agents/$1.md"
  {
    printf 'name = "%s"\n' "$1"
    [ -n "$3" ] && printf 'sandbox_mode = "%s"\n' "$3"
    printf 'developer_instructions = """本文"""\n'
  } > "$WORK/.codex/agents/$1.toml"
}
mk "role-ok-ro" "Read, Bash" "read-only"
mk "role-ok-rw" "Read, Edit, Write, Bash" "workspace-write"
mk "role-too-wide" "Read, Bash" "workspace-write"
mk "role-too-narrow" "Read, Edit, Write" "read-only"
mk "role-no-mode" "Read, Bash" ""
printf 'name = "role-orphan"\nsandbox_mode = "read-only"\ndeveloper_instructions = """本文"""\n' > "$WORK/.codex/agents/role-orphan.toml"

OUT="$(find_sandbox_mismatches "$WORK")"
if printf '%s\n' "$OUT" | grep -q 'sandbox-mismatch: role-too-wide.toml'; then
  assert_ok "読み取り専用のはずが workspace-write なのを検知（権限が広すぎる側）"
else
  assert_fail "広すぎる権限を検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'sandbox-mismatch: role-too-narrow.toml'; then
  assert_ok "書き込みロールが read-only なのを検知（通したい向きも見る。C-024）"
else
  assert_fail "狭すぎる権限を検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'no-sandbox-mode: role-no-mode.toml'; then
  assert_ok "sandbox_mode の明示漏れを検知"
else
  assert_fail "明示漏れを検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'no-source: role-orphan.toml'; then
  assert_ok "正本の md が無い toml を検知"
else
  assert_fail "正本なしを検知できない" "$OUT"
fi
# 誤検知しない側（対を置く。C-021）
if printf '%s\n' "$OUT" | grep -q 'role-ok-ro'; then
  assert_fail "そろっている読み取り専用ロールを誤検知した" "$OUT"
else
  assert_ok "そろっている読み取り専用ロールは通る"
fi
if printf '%s\n' "$OUT" | grep -q 'role-ok-rw'; then
  assert_fail "そろっている書き込みロールを誤検知した" "$OUT"
else
  assert_ok "そろっている書き込みロールは通る"
fi

echo "=== scenario 4: Codex を使わない導入先では黙る ==="
WORK2="$WORK/fx2"
mkdir -p "$WORK2/.claude/agents"
printf -- '---\nname: role-ok\ntools: Read\n---\n本文\n' > "$WORK2/.claude/agents/role-ok.md"
OUT2="$(find_sandbox_mismatches "$WORK2")"
if [ -z "$OUT2" ]; then
  assert_ok "Codex の agent を持たない導入先では何も言わない"
else
  assert_fail "Codex 未使用の導入先で誤検知した" "$OUT2"
fi

echo "=== scenario 5: toml はあるのに正本を 1 件も拾えなければ落ちる（fail-open 防止） ==="
WORK3="$WORK/fx3"
mkdir -p "$WORK3/.codex/agents"
printf 'name = "role-ok"\nsandbox_mode = "read-only"\ndeveloper_instructions = """本文"""\n' > "$WORK3/.codex/agents/role-ok.toml"
OUT3="$(find_sandbox_mismatches "$WORK3")"
if printf '%s\n' "$OUT3" | grep -q 'empty-scan:'; then
  assert_ok "正本を拾えないのを走査の故障として検知"
else
  assert_fail "空振りを検知できない" "$OUT3"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
