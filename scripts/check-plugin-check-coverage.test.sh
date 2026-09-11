#!/usr/bin/env bash
# WHY: 見つけた実害をルール（検査）にしても、それが派生先へ配られなければ同じ穴が他リポジトリで
#      空く。2026-09-07 まで、プラグインは hook 本体だけを配り、**検査は 1 本も配っていなかった**。
#      「ルール化して他リポジトリでも使う」を成立させるため、検査を足したら層を決めるまで通さない。
#
#      検査の層は 3 通りのどれかで決まる:
#        1. 対象スクリプト（check-x.sh に対する check-x.test.sh）がある → 対象と同じ層に自動で付いていく
#        2. 対象を持たない構造テスト → plugin-layout.json の checks に書く
#        3. 配らない → checksNotDistributed に**理由つきで**書く（「面倒だから」は理由にしない）
#
#   (a) scripts/ と scripts/lib/ の全 *.test.sh が上の 3 通りのどれかに当てはまる
#   (b) checks / checksNotDistributed に、実在しないファイルの行が残っていない（消したら表からも消す）
#   (c) checksNotDistributed の理由が空でない
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-plugin-check-coverage.test.sh
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

# $1=リポジトリルート。違反を 1 行ずつ出す
find_unclassified() {
  node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const layoutPath = path.join(root, "scripts/lib/plugin-layout.json")
if (!fs.existsSync(layoutPath)) { console.log("layout: scripts/lib/plugin-layout.json が無い"); process.exit(0) }
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"))
const strip = (s) => s.replace(/\.(sh|mjs|ts|jq)$/, "")

// 対象スクリプトを持つ検査（自動で層が決まる）
const withSubject = new Set()
const add = (name) => {
  const t = strip(name) + ".test.sh"
  if (fs.existsSync(path.join(root, "scripts", t))) withSubject.add(t)
}
for (const n of Object.keys(layout.hookScripts ?? {})) add(n)
for (const n of Object.keys(layout.supportScripts ?? {})) add(n)
for (const n of Object.keys(layout.bin ?? {})) add(n)

const declared = new Set(Object.keys(layout.checks ?? {}).filter((k) => !k.startsWith("_")))
const notDistributed = Object.entries(layout.checksNotDistributed ?? {}).filter(([k]) => !k.startsWith("_"))
const notDistributedNames = new Set(notDistributed.map(([k]) => k))
// 「分ければ配れる」= 返す当てのある借金。エンジンは汎用で、対象・閾値だけが固有なもの
const splittable = Object.entries(layout.checksSplittable ?? {}).filter(
  ([k]) => !k.startsWith("_") && k !== "splittableMax",
)
const splittableNames = new Set(splittable.map(([k]) => k))
const splittableMax = layout.checksSplittable?.splittableMax

// 実在する検査を集める（scripts/ と scripts/lib/）
const tests = []
for (const dir of ["scripts", "scripts/lib"]) {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) continue
  for (const f of fs.readdirSync(abs).sort()) {
    if (!f.endsWith(".test.sh")) continue
    tests.push(dir === "scripts" ? f : "lib/" + f)
  }
}

for (const t of tests) {
  if (withSubject.has(t) || declared.has(t) || notDistributedNames.has(t) || splittableNames.has(t)) continue
  console.log(`unclassified: ${t}（対象スクリプトが層の表に無く、checks / checksNotDistributed / checksSplittable にも無い）`)
}
// 表に残った幽霊
for (const name of [...declared, ...notDistributedNames, ...splittableNames]) {
  const rel = name.startsWith("lib/") ? path.join("scripts", name) : path.join("scripts", name)
  if (!fs.existsSync(path.join(root, rel))) console.log(`stale: ${name}（ファイルが無いのに層の表に残っている）`)
}
for (const [name, reason] of notDistributed) {
  if (!String(reason ?? "").trim()) console.log(`no-reason: ${name}（配らない理由が空）`)
}
// 分ければ配れるものは「何を出せば配れるか」を書かせる（「あとで」で済ませない）
for (const [name, reason] of splittable) {
  if (String(reason ?? "").trim().length < 20) {
    console.log(`no-plan: ${name}（何を登録簿・設定へ出せば配れるかが書かれていない）`)
  }
}
// ratchet: 返す当てのある借金は**増やさない**（減らすのは人が決めるので上限だけを見る）
if (typeof splittableMax !== "number") {
  console.log("no-max: checksSplittable.splittableMax が無い（増えても気づけない）")
} else if (splittable.length > splittableMax) {
  console.log(
    `over-max: 分ければ配れる検査が ${splittable.length} 件で上限 ${splittableMax} を超えた` +
      "（出してから足すか、出せない理由なら checksNotDistributed へ）",
  )
}
' "$1"
}

echo "=== scenario 1: 実態の検査がすべて層を持つ ==="
OUT="$(find_unclassified "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "未分類・幽霊・理由なし いずれも 0 件"
else
  assert_fail "検査の層が決まっていない" "$OUT
      直し方: 対象スクリプトを層の表に足すか、scripts/lib/plugin-layout.json の checks に層を書くか、
      配らないなら checksNotDistributed に理由を書く"
fi

echo "=== scenario 2: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts/lib"

cat > "$WORK/scripts/lib/plugin-layout.json" <<'EOF'
{
  "hookScripts": { "check-known.sh": "aidd-core" },
  "supportScripts": {},
  "bin": {},
  "checks": { "check-standalone.test.sh": "aidd-core", "check-ghost.test.sh": "aidd-core" },
  "checksNotDistributed": { "check-skipped.test.sh": "" }
}
EOF
printf 'echo hook\n' > "$WORK/scripts/check-known.sh"
printf 'echo test\n' > "$WORK/scripts/check-known.test.sh"
printf 'echo test\n' > "$WORK/scripts/check-standalone.test.sh"
printf 'echo test\n' > "$WORK/scripts/check-skipped.test.sh"
printf 'echo test\n' > "$WORK/scripts/check-forgotten.test.sh"

OUT="$(find_unclassified "$WORK")"
if grep -q 'unclassified: check-forgotten.test.sh' <<<"$OUT"; then
  assert_ok "層を決めていない検査を検知"
else
  assert_fail "未分類を検知できない" "$OUT"
fi
if grep -q 'unclassified: check-known.test.sh' <<<"$OUT"; then
  assert_fail "対象スクリプトがある検査を誤検知した" "$OUT"
else
  assert_ok "対象がある検査は自動で層が決まる"
fi
if grep -q 'stale: check-ghost.test.sh' <<<"$OUT"; then
  assert_ok "消えたファイルが表に残っているのを検知"
else
  assert_fail "幽霊エントリを検知できない" "$OUT"
fi
if grep -q 'no-reason: check-skipped.test.sh' <<<"$OUT"; then
  assert_ok "配らない理由が空なのを検知"
else
  assert_fail "理由なしを検知できない" "$OUT"
fi

echo "=== scenario 3: 「分ければ配れる」の借金が増えたら落ちる（RED 方向の自己検証） ==="
# WHY(2026-09-09 新設): 「エンジンが固有で配れない」と「対象だけが固有で、分ければ配れる」は別物。
#      後者は**返す当てのある借金**なので、理由の文章ではなく件数で見る。
#      作業ディレクトリは $WORK の下に作り、既存の trap で片付ける
WORK2="$WORK/fx2"
mkdir -p "$WORK2/scripts/lib"
cat > "$WORK2/scripts/lib/plugin-layout.json" <<'EOF'
{
  "hookScripts": {},
  "supportScripts": {},
  "bin": {},
  "checks": {},
  "checksNotDistributed": {},
  "checksSplittable": {
    "splittableMax": 1,
    "check-a.test.sh": "対象の一覧を登録簿へ出せば配れる（何を出すかを具体的に書いた行）",
    "check-b.test.sh": "あとで"
  }
}
EOF
printf 'echo test\n' > "$WORK2/scripts/check-a.test.sh"
printf 'echo test\n' > "$WORK2/scripts/check-b.test.sh"

OUT2="$(find_unclassified "$WORK2")"
if grep -q 'over-max: 分ければ配れる検査が 2 件' <<<"$OUT2"; then
  assert_ok "借金が上限を超えたのを検知"
else
  assert_fail "上限超過を検知できない" "$OUT2"
fi
if grep -q 'no-plan: check-b.test.sh' <<<"$OUT2"; then
  assert_ok "「あとで」のような中身の無い理由を検知"
else
  assert_fail "出し方が書かれていないのを検知できない" "$OUT2"
fi
if grep -q 'unclassified: check-a.test.sh' <<<"$OUT2"; then
  assert_fail "checksSplittable に書いた検査を未分類と誤検知した" "$OUT2"
else
  assert_ok "checksSplittable も層として数える"
fi

echo "=== scenario 4: 上限を書き忘れたら落ちる（増えても気づけない状態を許さない） ==="
WORK3="$WORK/fx3"
mkdir -p "$WORK3/scripts/lib"
cat > "$WORK3/scripts/lib/plugin-layout.json" <<'EOF'
{
  "hookScripts": {},
  "supportScripts": {},
  "bin": {},
  "checks": {},
  "checksNotDistributed": {},
  "checksSplittable": { "check-a.test.sh": "対象の一覧を登録簿へ出せば配れる（何を出すかを具体的に書いた行）" }
}
EOF
printf 'echo test\n' > "$WORK3/scripts/check-a.test.sh"
OUT3="$(find_unclassified "$WORK3")"
if grep -q 'no-max:' <<<"$OUT3"; then
  assert_ok "上限の書き忘れを検知"
else
  assert_fail "上限の書き忘れを検知できない" "$OUT3"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
