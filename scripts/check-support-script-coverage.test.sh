#!/usr/bin/env bash
# WHY: **`scripts/` の非テストスクリプトには、層の表との突合が無かった。**
#
#      検査（*.test.sh）は `check-plugin-check-coverage.test.sh` が、
#      agent / skill / workflow は `check-plugin-asset-coverage.test.sh` が両方向で見ている。
#      支援スクリプトだけが外れていて、**表に無いものは「配らないと判断した」のか
#      「足し忘れた」のかが記録から区別できない**——この穴は
#      `docs/plugin/KNOWN-LIMITS.md` と `check-plugin-asset-coverage.test.sh` の限界の、
#      **2 か所で同じ文言で申告されていた**（申告したまま誰も埋めなかった）。
#
#      2026-09-12 に実測して、どこの表にも載っていない非テストスクリプトが実際にあると分かった。
#      配る・配らないの判断そのものは製品の判断なので、この検査では決めない。
#      代わりに**判断の置き場を作り、未分類の数を上限で固定する**——
#      新しく足す人は必ずどれかに書くことになり、未分類は増やせないが減らせる
#      （`checksSplittable` と同じ「返す当てのある借金」の形）。
#
#      見るもの:
#   (a) 実体があるのに、どの表にも載っていない（＝黙って配られない／配られる、が決まらない）
#   (b) 表に載っているのに実体が無い（幽霊）
#   (c) 「配らない」の理由が空（「面倒だから」は理由にしない）
#   (d) 未分類が上限を超えた・上限の書き忘れ（ratchet）
#   (e) 走査が空振りしていない（C-044）
#   (f) fixture で (a)(c)(d) を検知できる（RED 方向の自己検証。C-022）
#
# 母集団の取り方（2026-09-12 の反省）:
#      1 回目の実測は `hookScripts` / `supportScripts` / `bin` / `workflowLib` の
#      **4 キーを手で選んで**数え、`checks` にも非テストスクリプトが載っていることを見落とした。
#      **キーを手で選んだ時点で母集団を外す。** この検査は層の表の全体を歩いて
#      `.sh` で終わるキーをすべて拾う——知らないキーが増えても取りこぼさない。
#
# 限界:
#   - 見るのは `scripts/` 直下の非テスト `.sh` だけ。`scripts/lib/` の部品と `.mjs`・`.py` は見ない。
#   - **どの表に載っているかは問わない**（配る側か配らない側かの妥当性は見ない）。
#     見るのは「どこかに書いてあるか」まで。分類が正しいかは人が決める。
#   - 未分類の上限は**宣言**で、正しさは機械で判定していない。上げれば通る——
#     上げるときに理由を書く運用が歯止め（`_howto` に書いてある）。
#
# 実行: bash scripts/check-support-script-coverage.test.sh
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
  echo "  SKIP: 確認不能（node が無いので層の表を読めません。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

# $1=リポジトリルート。違反を 1 行ずつ出す（違反が無ければ何も出さない）
find_uncovered() {
  node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const layoutPath = path.join(root, "scripts/lib/plugin-layout.json")
if (!fs.existsSync(layoutPath)) { console.log("no-layout: scripts/lib/plugin-layout.json が無い") ; process.exit(0) }
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"))

// 層の表の全体を歩いて .sh のキーを集める（キーを手で選ばない）
const declared = new Set()
const walk = (node) => {
  if (Array.isArray(node)) { for (const v of node) walk(v) ; return }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_")) continue
      if (k.endsWith(".sh")) declared.add(path.basename(k))
      walk(v)
    }
  }
}
walk(layout)

const clean = (name) => {
  const t = layout[name]
  if (!t || typeof t !== "object") return []
  return Object.entries(t).filter(([k]) => !k.startsWith("_") && k.endsWith(".sh"))
}
const notDistributed = clean("supportScriptsNotDistributed")
const unclassified = clean("supportScriptsUnclassified")

const scriptsDir = path.join(root, "scripts")
const onDisk = fs.existsSync(scriptsDir)
  ? fs.readdirSync(scriptsDir).filter((n) => n.endsWith(".sh") && !n.endsWith(".test.sh")).sort()
  : []

// (e) 空振り防止
if (onDisk.length === 0) {
  console.log("empty-scan: scripts/ の非テスト .sh を 1 本も拾えない（走査が壊れている疑い。C-044）")
  process.exit(0)
}

// (a) どの表にも載っていない
for (const name of onDisk) {
  if (!declared.has(name)) {
    console.log("uncovered: " + name + "（どの層の表にも無い。配るのか配らないのか記録から分からない）")
  }
}
// (b) 幽霊
for (const [name] of [...notDistributed, ...unclassified]) {
  if (!fs.existsSync(path.join(scriptsDir, path.basename(name)))) {
    console.log("stale: " + name + "（実体が無いのに表に残っている）")
  }
}
// (c) 配らない理由が空
for (const [name, reason] of notDistributed) {
  if (!String(reason ?? "").trim()) console.log("no-reason: " + name + "（配らない理由が空）")
}
// (d) 未分類の ratchet
const table = layout.supportScriptsUnclassified
const max = table && typeof table.unclassifiedMax === "number" ? table.unclassifiedMax : null
if (unclassified.length > 0 && max === null) {
  console.log("no-max: supportScriptsUnclassified に unclassifiedMax が無い（増えても気づけない）")
} else if (max !== null && unclassified.length > max) {
  console.log("over-max: 未分類が " + unclassified.length + " 件で上限 " + max + " を超えた")
}
' "$1"
}

echo "=== scenario 1: 非テストスクリプトがすべてどこかの表に載っている ==="
OUT="$(find_uncovered "${REPO_ROOT}")"
if [ -z "${OUT}" ]; then
  assert_ok "未分類・幽霊・理由なし・上限超過 いずれも 0 件"
else
  assert_fail "支援スクリプトの扱いが記録から分からない" "${OUT}
      直し方: scripts/lib/plugin-layout.json の supportScripts / bin などへ足して配るか、
      配らないなら supportScriptsNotDistributed に理由を書く。
      まだ決められないなら supportScriptsUnclassified へ（上限を上げるときは理由も書く）"
fi

echo "=== scenario 2: 走査が実体を拾えている（空振り防止。C-044） ==="
COUNT="$(find "${REPO_ROOT}/scripts" -maxdepth 1 -name '*.sh' -not -name '*.test.sh' | wc -l | tr -d ' ')"
if [ "${COUNT:-0}" -ge 20 ]; then
  assert_ok "非テストスクリプトを ${COUNT} 本拾えている"
else
  assert_fail "非テストスクリプトが ${COUNT:-0} 本しか拾えない" "走査の前提が崩れている（scenario 1 の緑は空振りの可能性）"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/scripts/lib"

cat > "${WORK}/scripts/lib/plugin-layout.json" <<'EOF'
{
  "supportScripts": { "listed.sh": "aidd-core" },
  "supportScriptsNotDistributed": { "wont-ship.sh": "中心リポジトリだけで使う", "no-why.sh": "" },
  "supportScriptsUnclassified": { "unclassifiedMax": 1, "pending-a.sh": "", "pending-b.sh": "" }
}
EOF
for n in listed.sh wont-ship.sh no-why.sh pending-a.sh pending-b.sh forgotten.sh; do
  printf 'echo hi\n' > "${WORK}/scripts/${n}"
done

OUT_BAD="$(find_uncovered "${WORK}")"
if grep -q 'uncovered: forgotten.sh' <<<"${OUT_BAD}"; then
  assert_ok "どの表にも無いスクリプトを名指しで検知"
else
  assert_fail "表に無いスクリプトを検知できない" "${OUT_BAD}"
fi
if grep -q 'no-reason: no-why.sh' <<<"${OUT_BAD}"; then
  assert_ok "配らない理由が空なのを検知"
else
  assert_fail "理由の空欄を検知できない" "${OUT_BAD}"
fi
if grep -q 'over-max' <<<"${OUT_BAD}"; then
  assert_ok "未分類が上限を超えたのを検知（ratchet）"
else
  assert_fail "未分類の増加を検知できない" "${OUT_BAD}"
fi
if grep -q 'listed.sh' <<<"${OUT_BAD}"; then
  assert_fail "表に載っているものを違反にしている" "${OUT_BAD}"
else
  assert_ok "表に載っているものは誤検知しない"
fi

echo "=== scenario 4: 幽霊と上限の書き忘れを検知する ==="
cat > "${WORK}/scripts/lib/plugin-layout.json" <<'EOF'
{
  "supportScripts": { "listed.sh": "aidd-core" },
  "supportScriptsNotDistributed": { "wont-ship.sh": "中心リポジトリだけで使う", "no-why.sh": "理由あり", "ghost.sh": "消したのに残っている" },
  "supportScriptsUnclassified": { "pending-a.sh": "", "pending-b.sh": "" }
}
EOF
printf 'echo hi\n' > "${WORK}/scripts/forgotten.sh"
OUT_GHOST="$(find_uncovered "${WORK}")"
if grep -q 'stale: ghost.sh' <<<"${OUT_GHOST}"; then
  assert_ok "実体の無い幽霊を検知"
else
  assert_fail "幽霊を検知できない" "${OUT_GHOST}"
fi
if grep -q 'no-max' <<<"${OUT_GHOST}"; then
  assert_ok "上限の書き忘れを検知"
else
  assert_fail "上限の書き忘れを検知できない" "${OUT_GHOST}"
fi

echo "=== scenario 5: 正しい fixture は 1 件も出さない（誤検知しない） ==="
cat > "${WORK}/scripts/lib/plugin-layout.json" <<'EOF'
{
  "supportScripts": { "listed.sh": "aidd-core" },
  "supportScriptsNotDistributed": { "wont-ship.sh": "中心リポジトリだけで使う", "no-why.sh": "理由あり", "forgotten.sh": "理由あり" },
  "supportScriptsUnclassified": { "unclassifiedMax": 2, "pending-a.sh": "", "pending-b.sh": "" }
}
EOF
OUT_GOOD="$(find_uncovered "${WORK}")"
if [ -z "${OUT_GOOD}" ]; then
  assert_ok "誤検知なし"
else
  assert_fail "正しい fixture で違反が出た" "${OUT_GOOD}"
fi

echo "=== scenario 6: 層の表が無ければ落ちる（黙って通らない） ==="
rm -f "${WORK}/scripts/lib/plugin-layout.json"
OUT_MISSING="$(find_uncovered "${WORK}")"
if grep -q 'no-layout' <<<"${OUT_MISSING}"; then
  assert_ok "層の表が無いことを検知"
else
  assert_fail "層の表が無いのに黙って通る" "${OUT_MISSING}"
fi

if [ "${fail}" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
