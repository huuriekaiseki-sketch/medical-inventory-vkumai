#!/usr/bin/env bash
# WHY: **是正の棚卸し（actuator-inventory.md）と hook の実登録を、誰も突き合わせていなかった。**
#
#      2026-09-12 に手で突き合わせたら、`.claude/settings.json` に登録され実際に動いているのに
#      表に 1 行も無い検知 hook が **7 本**あった——check-empty-session-report /
#      check-hook-dependencies / 鮮度 4 本（統合・E2E・RLS 変異・Stryker）/ check-escape-ledger。
#      とくに鮮度 4 本は、harness-map.md が H-02 / H-05 / H-06 で
#      「人が打つが**打ち忘れは機械が拾う**」と説明している担保の実体そのもので、
#      それが是正の棚卸しから丸ごと漏れていた。読む人は「打ち忘れ検知は止めるのか警告だけか」を
#      表から判断できない。集計も「約 23 件」のままで、実数は 30 件だった。
#
#      **この形は 2 度目。** 表の中に 2026-08-10 の訂正が残っている——verify-claims.sh を
#      warning-only と誤記していた実例で、そこに「cardiosearch 側 issue #5 でこの種の乖離を
#      機械検知する仕組みを導入済み、**本リポジトリへの逆輸入は未着手**」と書いてあった。
#      **その未着手がそのまま 2 例目を招いた**（1 本の誤記 → 7 本の欠落へ規模が拡大）。
#      型は C-047（層の表に載っていないものは黙って抜ける）と同じで、
#      隣の仕組み（plugin-layout.json と settings.json）は最初から両方向で突き合わせている。
#
#      見るもの:
#   (a) 登録されている検知 hook が、すべて棚卸し表に出てくる
#   (b) 走査が空振りしていない（登録を 1 件も拾えないのは走査の故障。C-044）
#   (c) fixture で (a) を検知できる（RED 方向の自己検証。C-022）
#
# 記録専用 hook の扱い: 表は log-subagent-hook-skeleton.sh 等を「検知ではなく記録専用」として
#      対象外にしている。**その名前を検査へ焼き込まない**——新しい記録専用 hook が増えたときに
#      腐るため（C-048 / C-049）。代わりに「systemMessage を出すか」を実測して分ける。
#
# 限界:
#   - **表のどこかに名前が出れば「載っている」と数える。** 行として正しい分類（block / ask /
#     warning-only）が付いているかは見ない。列を厳密に読むと、備考中の言及
#     （queue-recovery-task.sh など）を幽霊として誤検知するため、意図して弱くしてある。
#     **2026-08-10 の 1 例目（verify-claims.sh を warning-only と誤記）はこの検査では捕まらない。**
#   - 逆向き（表にあるのに登録が無い＝幽霊）も見ていない。同じ理由（備考の言及と区別できない）。
#   - Codex 側（.codex/hooks.json）は登録の有無だけを見る。Codex にはプラグイン機構が無く、
#     配布対象外なので、ここで見るのは中心リポジトリの整合だけ。
#
# 実行: bash scripts/check-actuator-inventory-coverage.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので登録と表を読めません。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

# $1=リポジトリルート。違反を 1 行ずつ出す（違反が無ければ何も出さない）
find_uncovered() {
  node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]

const readJson = (rel) => {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return null
  try { return JSON.parse(fs.readFileSync(abs, "utf8")) } catch (e) { return null }
}

// 登録された hook のスクリプト名を集める。
// settings.json は hooks キーの下だけを見る（permissions の allow 一覧を拾わないため）。
const collect = (node, out) => {
  if (node === null || node === undefined) return
  if (typeof node === "string") {
    const m = /scripts\/([\w.-]+\.sh)/.exec(node)
    if (m) out.add(m[1])
    return
  }
  if (Array.isArray(node)) { for (const v of node) collect(v, out) ; return }
  if (typeof node === "object") { for (const v of Object.values(node)) collect(v, out) }
}

const registered = new Set()
const settings = readJson(".claude/settings.json")
if (settings && settings.hooks) collect(settings.hooks, registered)
const codex = readJson(".codex/hooks.json")
if (codex) collect(codex, registered)

const docPath = path.join(root, "docs/agents/actuator-inventory.md")
if (!fs.existsSync(docPath)) { console.log("no-doc: docs/agents/actuator-inventory.md が無い") ; process.exit(0) }
const doc = fs.readFileSync(docPath, "utf8")

// (b) 空振り防止
if (registered.size === 0) {
  console.log("empty-scan: hook の登録を 1 件も拾えない（走査が壊れている疑い。C-044）")
  process.exit(0)
}

for (const name of [...registered].sort()) {
  const abs = path.join(root, "scripts", name)
  if (!fs.existsSync(abs)) continue
  // 記録専用（警告を出さない）は棚卸しの対象外。名前ではなく実測で分ける
  const body = fs.readFileSync(abs, "utf8")
  if (!body.includes("systemMessage")) continue
  // (a) 表のどこかに名前が出るか
  if (!doc.includes(name)) {
    console.log("uncovered: " + name + "（登録されて動いているのに、是正の棚卸しに 1 度も出てこない）")
  }
}
' "$1"
}

echo "=== scenario 1: 登録されている検知 hook がすべて棚卸し表に出てくる ==="
OUT="$(find_uncovered "${REPO_ROOT}")"
if [ -z "${OUT}" ]; then
  assert_ok "棚卸しに出てこない検知 hook は 0 件"
else
  assert_fail "実際に動いているのに是正の棚卸しに無い検知 hook がある" "${OUT}
      直し方: docs/agents/actuator-inventory.md の表へ行を足し、
      block / ask / deny / 自動復旧（queue）/ warning-only のどれかを決めて書く。
      「集計と評価」の件数も数え直す（表と集計はよくずれる）"
fi

echo "=== scenario 2: 走査が登録を拾えている（空振り防止。C-044） ==="
COUNT="$(node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const s = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"))
const out = new Set()
const walk = (n) => {
  if (typeof n === "string") { const m = /scripts\/([\w.-]+\.sh)/.exec(n) ; if (m) out.add(m[1]) ; return }
  if (Array.isArray(n)) { for (const v of n) walk(v) ; return }
  if (n && typeof n === "object") { for (const v of Object.values(n)) walk(v) }
}
walk(s.hooks ?? {})
console.log(out.size)
' "${REPO_ROOT}" 2>/dev/null)"
if [ "${COUNT:-0}" -ge 10 ]; then
  assert_ok "hook の登録を ${COUNT} 本拾えている"
else
  assert_fail "hook の登録が ${COUNT:-0} 本しか拾えない" "走査の前提が崩れている（scenario 1 の緑は空振りの可能性）"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/scripts" "${WORK}/docs/agents" "${WORK}/.claude"

cat > "${WORK}/.claude/settings.json" <<'EOF'
{
  "permissions": { "allow": ["Bash(bash scripts/not-a-hook.sh:*)"] },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/hook-listed.sh" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/hook-forgotten.sh" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/hook-recorder.sh" }
        ]
      }
    ]
  }
}
EOF
printf 'echo systemMessage\n' > "${WORK}/scripts/hook-listed.sh"
printf 'echo systemMessage\n' > "${WORK}/scripts/hook-forgotten.sh"
printf 'echo "just a log line"\n' > "${WORK}/scripts/hook-recorder.sh"
printf 'echo systemMessage\n' > "${WORK}/scripts/not-a-hook.sh"
cat > "${WORK}/docs/agents/actuator-inventory.md" <<'EOF'
| Hookイベント | スクリプト | 分類 | 備考 |
|---|---|---|---|
| SessionStart | `hook-listed.sh` | warning-only | 載っている |
EOF

OUT_BAD="$(find_uncovered "${WORK}")"
if grep -q 'uncovered: hook-forgotten.sh' <<<"${OUT_BAD}"; then
  assert_ok "棚卸しに無い検知 hook を名指しで検知"
else
  assert_fail "棚卸しの抜けを検知できない" "${OUT_BAD}"
fi
if grep -q 'hook-recorder.sh' <<<"${OUT_BAD}"; then
  assert_fail "記録専用 hook を違反にしている（systemMessage を出さないものは対象外）" "${OUT_BAD}"
else
  assert_ok "記録専用 hook は誤検知しない（名前ではなく実測で分けている）"
fi
if grep -q 'not-a-hook.sh' <<<"${OUT_BAD}"; then
  assert_fail "permissions の allow 一覧を hook として拾っている" "${OUT_BAD}"
else
  assert_ok "permissions の allow 一覧は拾わない（hooks キーの下だけを見る）"
fi

echo "=== scenario 4: 正しい fixture は 1 件も出さない（誤検知しない） ==="
cat > "${WORK}/docs/agents/actuator-inventory.md" <<'EOF'
| Hookイベント | スクリプト | 分類 | 備考 |
|---|---|---|---|
| SessionStart | `hook-listed.sh` | warning-only | 載っている |
| SessionStart | `hook-forgotten.sh` | warning-only | こちらも載せた |
EOF
OUT_GOOD="$(find_uncovered "${WORK}")"
if [ -z "${OUT_GOOD}" ]; then
  assert_ok "誤検知なし"
else
  assert_fail "正しい fixture で違反が出た" "${OUT_GOOD}"
fi

echo "=== scenario 5: 棚卸しの文書が無ければ落ちる（黙って通らない） ==="
rm -f "${WORK}/docs/agents/actuator-inventory.md"
OUT_MISSING="$(find_uncovered "${WORK}")"
if grep -q 'no-doc' <<<"${OUT_MISSING}"; then
  assert_ok "文書が無いことを検知"
else
  assert_fail "文書が無いのに黙って通る" "${OUT_MISSING}"
fi

if [ "${fail}" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
