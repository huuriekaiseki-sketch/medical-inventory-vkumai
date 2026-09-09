#!/usr/bin/env bash
# WHY(C-030、2026-09-09): `scripts/lib/fixture-guard.mjs` の回帰テスト。
#      「後片付けが自分の作った行以外を消していないか」を、
#      **走り出す前の姿を控えて、終わったあと突き合わせる**ことで測る仕組みの判定部分。
#
#      判定が空振りすると「消えていない」で緑になる（いちばん危ない外れ方）ので、次を固定する:
#
#   1. 消えた行を名指しで出す
#   2. 走行中に増えた行は違反にしない（**自分が作ったものは自由に消せる**）
#   3. 複合主キー（`user_facilities`）でも鍵が作れる
#   4. 控えていない表を鍵にしようとしたら落ちる（黙って空を返さない）
#   5. テーブル台帳の実装済みの表が、控えるか外すかのどちらかに必ず入っている（ratchet）
#   6. 外す理由が短ければ落ちる（下限そのものを境界 19/20 文字で固定する）
#
# 実行: bash scripts/check-fixture-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected: $2"; echo "      actual:   $1"; fail=1; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected to find: $2"; echo "      actual: $1"; fail=1; fi
}

run_node() { node --input-type=module - "$REPO_ROOT" 2>&1; }

echo "=== scenario 1: 消えた行を名指しで出す / 増えた行は違反にしない ==="
OUT="$(run_node <<'NODE'
const { findVanished } = await import(`file://${process.argv[2]}/scripts/lib/fixture-guard.mjs`)
const snapshot = { hospital_prices: ['p1', 'p2'], price_histories: ['h1'] }
// p2 と h1 が消え、走行中に p9 が増えた
const present = { hospital_prices: ['p1', 'p9'], price_histories: [] }
const gone = findVanished(snapshot, present)
console.log(JSON.stringify(gone))
NODE
)"
assert_contains "$OUT" "hospital_prices: p2" "消えた行を名指し"
assert_contains "$OUT" "price_histories: h1" "連鎖で消えた行も名指し"
if printf '%s' "$OUT" | grep -q 'p9'; then
  echo "  NG: 走行中に増えた行を違反にしている"; fail=1
else
  echo "  OK: 走行中に増えた行は違反にしない"
fi

echo "=== scenario 2: 何も消えていなければ 0 件 ==="
OUT="$(run_node <<'NODE'
const { findVanished } = await import(`file://${process.argv[2]}/scripts/lib/fixture-guard.mjs`)
console.log(JSON.stringify(findVanished({ products: ['a', 'b'] }, { products: ['b', 'a', 'c'] })))
NODE
)"
assert_eq "$OUT" "[]" "誤検知なし"

echo "=== scenario 3: 複合主キーでも鍵が作れる / 控えていない表は落ちる ==="
OUT="$(run_node <<'NODE'
const { keyOf } = await import(`file://${process.argv[2]}/scripts/lib/fixture-guard.mjs`)
console.log(keyOf('user_facilities', { user_id: 'u1', facility_id: 'f1' }))
try {
  keyOf('audit_log', { id: 'x' })
  console.log('NO-THROW')
} catch (e) {
  // WHY(文言まで見る): 落ちさえすればよいのではない。E2E の途中で出るので、
  //      **どの表で詰まったか**が読めないと直せない（変異計測 CM-007 で、
  //      名指しを外しても素の TypeError で落ちるだけなので緑のままだと分かった）
  console.log(`THREW ${e.message}`)
}
NODE
)"
assert_contains "$OUT" "u1|f1" "複合主キーを連結する"
assert_contains "$OUT" "THREW" "控えていない表は黙って空を返さない"
assert_contains "$OUT" "audit_log は控える表に入っていない" "どの表で詰まったかを名指しする"

echo "=== scenario 4: 台帳の表がすべて「控える / 外す」のどちらかに入っている（ratchet） ==="
OUT="$(run_node <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const { checkTableCoverage } = await import(`file://${root}/scripts/lib/fixture-guard.mjs`)
const text = fs.readFileSync(path.join(root, 'docs/agents/table-rulebook.md'), 'utf8')
const tables = []
for (const line of text.split('\n')) {
  if (!line.startsWith('| TB-')) continue
  const c = line.split('|').map((x) => x.trim())
  if (c[8] !== '実装済み') continue
  tables.push(c[2])
}
if (tables.length < 15) {
  console.log(`FEWTABLES ${tables.length}`)
} else {
  const r = checkTableCoverage(tables)
  console.log(JSON.stringify(r))
}
NODE
)"
assert_contains "$OUT" '"undecided":[]' "決めていない表が無い"
assert_contains "$OUT" '"stale":[]' "台帳から消えた表が残っていない"
assert_contains "$OUT" '"noReason":[]' "外す理由がすべて書かれている"

echo "=== scenario 5: 決めていない表・短い理由を検知できる（RED 方向） ==="
OUT="$(run_node <<'NODE'
const root = process.argv[2]
const { checkTableCoverage } = await import(`file://${root}/scripts/lib/fixture-guard.mjs`)
const r = checkTableCoverage(['products', 'brand_new_table'])
console.log(JSON.stringify(r.undecided))
console.log(r.stale.length > 0 ? 'HAS-STALE' : 'NO-STALE')
NODE
)"
assert_contains "$OUT" "brand_new_table" "新しい表を「決めていない」で検知"
assert_contains "$OUT" "HAS-STALE" "台帳に無い宣言も検知"

# WHY(境界そのものを固定する): 「理由が短ければ落ちる」は 2026-09-09 まで**どこも測っていなかった**。
#      変異計測（CM-006）で下限を 20 → 1 に緩めても緑のままだと分かったので、境界を 2 点で留める。
OUT="$(run_node <<'NODE'
const root = process.argv[2]
const { reasonsTooShort, MIN_REASON_LENGTH } = await import(`file://${root}/scripts/lib/fixture-guard.mjs`)
const short = 'あ'.repeat(MIN_REASON_LENGTH - 1)
const enough = 'あ'.repeat(MIN_REASON_LENGTH)
console.log(JSON.stringify({
  min: MIN_REASON_LENGTH,
  blank: reasonsTooShort({ t_blank: '   ' }),
  short: reasonsTooShort({ t_short: short }),
  enough: reasonsTooShort({ t_enough: enough }),
}))
NODE
)"
assert_contains "$OUT" '"min":20' "下限は 20 文字"
assert_contains "$OUT" '"blank":["t_blank"]' "空白だけの理由を検知"
assert_contains "$OUT" '"short":["t_short"]' "下限より 1 文字短い理由を検知（境界）"
assert_contains "$OUT" '"enough":[]' "下限ちょうどの理由は通す（境界）"

echo "=== scenario 6: E2E 側の配線が残っている（外されたら気づく） ==="
CONFIG="$REPO_ROOT/playwright.config.ts"
SETUP="$REPO_ROOT/e2e/global-setup.ts"
if grep -q "globalTeardown" "$CONFIG"; then echo "  OK: playwright.config.ts が teardown を呼ぶ"; else
  echo "  NG: globalTeardown の配線が外れている"; fail=1; fi
if grep -q "snapshotProtectedRows" "$SETUP"; then echo "  OK: globalSetup が控えを取る"; else
  echo "  NG: 控えを取る呼び出しが外れている（控えが無いと「消えていない」と言えてしまう）"; fail=1; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
