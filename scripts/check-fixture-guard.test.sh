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
#   7. E2E・統合の**両方**で配線が外れていない（控えるだけ／突き合わせるだけ、を検知する）
#   10. 消し残し（後片付けの漏れ）を、消しすぎと**逆向き**に数えられている
#   8-9. **落ちる前提そのもの**を毎回測り直す（2026-09-09 追加）
#
#      「teardown で投げれば実行が落ちる」は走らせる仕組みごとに答えが違った:
#        - Playwright（E2E）  … throw だけで exit 1
#        - vitest（統合）      … throw だけでは **exit 0 のまま**。`process.exitCode` が要る
#      どちらも思い込みで書けてしまうところなので、実際に vitest / playwright を起動して測る。
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
  if grep -qF -- "$2" <<<"$1"; then echo "  OK: $3"; else
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
if grep -q 'p9' <<<"$OUT"; then
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

echo "=== scenario 10: 消し残し（後片付けの漏れ）を数える ==="
# WHY(2026-09-10): C-030 は「消しすぎ」を測るが、統合テストで実際に積み上がっていたのは
#      **消し残し**のほうだった（緑の全件実行 1 回につき 41 行を実測）。
#      判定は消しすぎと**逆向き**なので、取り違えると常に 0 件で緑になる。両方向を固定する。
OUT="$(run_node <<'NODE'
const { findLeaked, findVanished } = await import(`file://${process.argv[2]}/scripts/lib/fixture-guard.mjs`)
const snapshot = { products: ['p1', 'p2'], categories: ['c1'] }
// p2 が消え（消しすぎ）、p9 と c9 が増えて残った（消し残し）
const present = { products: ['p1', 'p9'], categories: ['c1', 'c9'] }
console.log(JSON.stringify({
  leaked: findLeaked(snapshot, present),
  vanished: findVanished(snapshot, present),
  none: findLeaked(snapshot, { products: ['p2', 'p1'], categories: ['c1'] }),
  unknownTable: findLeaked({}, { brand_new: ['x'] }),
}))
NODE
)"
assert_contains "$OUT" '"leaked":["categories: c9","products: p9"]' "増えて残った行だけを名指しする"
assert_contains "$OUT" '"vanished":["products: p2"]' "消えた行と混ざらない（向きが逆）"
assert_contains "$OUT" '"none":[]' "増えていなければ 0 件（誤検知なし）"
assert_contains "$OUT" '"unknownTable":["brand_new: x"]' "控えに無い表は黙って見逃さない"

echo "=== scenario 7: 統合テスト側の配線が残っている（外されたら気づく） ==="
INT_SETUP="$REPO_ROOT/supabase/__tests__/integration/helpers/global-setup.ts"
INT_CONFIG="$REPO_ROOT/vitest.integration.config.ts"
if grep -q "helpers/global-setup" "$INT_CONFIG"; then echo "  OK: vitest.integration.config.ts が globalSetup を指す"; else
  echo "  NG: globalSetup の配線が外れている"; fail=1; fi
if grep -q "snapshotIntegrationRows" "$INT_SETUP"; then echo "  OK: 統合の globalSetup が控えを取る"; else
  echo "  NG: 控えを取る呼び出しが外れている"; fail=1; fi
if grep -q "verifyIntegrationRows" "$INT_SETUP"; then echo "  OK: 返した teardown が突き合わせる"; else
  echo "  NG: 突き合わせの呼び出しが外れている（控えるだけでは何も測っていない）"; fail=1; fi
# WHY(exitCode まで見る): vitest は teardown の throw だけでは落ちない（scenario 8 で実測）。
#      throw だけの実装に戻されたら、緑のまま何も守らなくなる
if grep -q "process.exitCode" "$REPO_ROOT/supabase/__tests__/integration/helpers/fixture-guard.ts"; then
  echo "  OK: 落とすのに process.exitCode を立てている"
else
  echo "  NG: throw だけでは vitest は exit 0 のまま（scenario 8 参照）"; fail=1; fi

# WHY(scenario 8・9 で走らせて測る、2026-09-09): 「teardown で投げれば実行が落ちる」は
#      **走らせる仕組みごとに答えが違った**。vitest は落ちず、Playwright は落ちる。
#      どちらも「そういうものだろう」で書いていたので、**前提そのものを毎回測り直す**。
#      これを測らないと C-022（壊して落ちることを確かめない）そのものになる。
probe_dir() {
  local d
  d="$(mktemp -d)"
  ln -sfn "$REPO_ROOT/node_modules" "$d/node_modules"
  printf '%s' "$d"
}

echo "=== scenario 8: vitest は teardown で exitCode を立てれば落ちる（立てなければ落ちない） ==="
if [ ! -x "$REPO_ROOT/node_modules/.bin/vitest" ]; then
  echo "  NG: node_modules/.bin/vitest が無く、前提を測れない（npm ci してから実行してください）"; fail=1
else
  D="$(probe_dir)"
  cat > "$D/setup.mjs" <<'PROBE'
export default async function globalSetup() {
  return async () => {
    if (process.env.PROBE_MODE === 'exitcode-then-throw') {
      process.exitCode = 1
      throw new Error('PROBE: exitCode を立ててから投げた')
    }
  }
}
PROBE
  cat > "$D/probe.test.mjs" <<'PROBE'
import { it, expect } from 'vitest'
it('trivially passes', () => { expect(1).toBe(1) })
PROBE
  cat > "$D/vitest.config.mjs" <<'PROBE'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['probe.test.mjs'], globalSetup: ['./setup.mjs'] },
})
PROBE
  PROBE_MODE=none "$REPO_ROOT/node_modules/.bin/vitest" run --root "$D" --config "$D/vitest.config.mjs" >"$D/none.log" 2>&1
  NONE_CODE=$?
  PROBE_MODE=exitcode-then-throw "$REPO_ROOT/node_modules/.bin/vitest" run --root "$D" --config "$D/vitest.config.mjs" >"$D/red.log" 2>&1
  RED_CODE=$?
  # 反対側（何もしなければ緑）を必ず一緒に測る。緑にならない probe は「常に落ちる」だけで何も示さない
  assert_eq "$NONE_CODE" "0" "何もしない teardown なら通る（probe が常に落ちるわけではない）"
  assert_eq "$RED_CODE" "1" "exitCode を立てて投げれば実行が落ちる（統合の fixture-guard が頼っている前提）"
  rm -rf "$D"
fi

echo "=== scenario 9: Playwright は teardown の throw だけで落ちる（E2E 側が頼っている前提） ==="
if [ ! -x "$REPO_ROOT/node_modules/.bin/playwright" ]; then
  echo "  NG: node_modules/.bin/playwright が無く、前提を測れない（npm ci してから実行してください）"; fail=1
else
  D="$(probe_dir)"
  cat > "$D/teardown.mjs" <<'PROBE'
export default async function globalTeardown() {
  if (process.env.PROBE_MODE === 'throw') throw new Error('PROBE: teardown threw')
}
PROBE
  cat > "$D/probe.spec.mjs" <<'PROBE'
import { test, expect } from '@playwright/test'
test('trivially passes without a browser', () => { expect(1).toBe(1) })
PROBE
  cat > "$D/playwright.config.mjs" <<'PROBE'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.', testMatch: /probe\.spec\.mjs/, globalTeardown: './teardown.mjs', reporter: 'line',
})
PROBE
  PROBE_MODE=none "$REPO_ROOT/node_modules/.bin/playwright" test --config "$D/playwright.config.mjs" >"$D/none.log" 2>&1
  NONE_CODE=$?
  PROBE_MODE=throw "$REPO_ROOT/node_modules/.bin/playwright" test --config "$D/playwright.config.mjs" >"$D/red.log" 2>&1
  RED_CODE=$?
  assert_eq "$NONE_CODE" "0" "何もしない teardown なら通る（反対側）"
  assert_eq "$RED_CODE" "1" "throw だけで実行が落ちる（E2E の fixture-guard が頼っている前提）"
  rm -rf "$D"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
