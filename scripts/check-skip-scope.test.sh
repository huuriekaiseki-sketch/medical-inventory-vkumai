#!/usr/bin/env bash
# WHY(2026-09-10、C-033「前提の範囲が、それを必要とする検査より広い」):
#      `e2e/api-cross-facility-attack.spec.ts` の ratchet（攻撃表と実在 route の突合）は
#      **ファイルを読むだけ**の検査なのに、同じ `test.describe` 直下の
#      `test.skip`（cross-facility フィクスチャ / SUPABASE_SERVICE_ROLE_KEY）に巻き込まれ、
#      Supabase を止めている間ずっとスキップされていた。
#      **スキップは失敗ではないのでレポート上は緑と同じ色で出る。**
#
#      実害を同日に実測: 認可チェックの無い route を実コードへ置いて回帰を回したところ、
#      typecheck / lint / 契約 / 入口 / 脅威モデルの **7 本すべてが通った**。
#      唯一気づけるはずだった ratchet が、この巻き込みで黙っていた。
#
#      固定するのは 4 つ:
#        (a) 実コードに違反が無い（ratchet を 0 で張る）
#        (b) **今日見つけた形そのもので落ちる**（実例を fixture に写して入力にする）
#        (c) 前提が本当に要るテスト（async）と、前提の無い describe を落とさない（対照）
#        (d) 走査が空振りしたら合格にしない（fail-open 防止）
#
# 実行: bash scripts/check-skip-scope.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-skip-scope.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

run_scan() { # $1 = 走査するディレクトリ
  SCAN_OUT="$(SKIP_SCOPE_SCAN_DIR="$1" SKIP_SCOPE_ALLOW_ZERO="${ALLOW_ZERO:-}" node "$SCAN" 2>&1)"
  SCAN_CODE=$?
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実コードに違反が無い（ratchet 0） ==="
ALLOW_ZERO= run_scan "$REPO_ROOT/e2e"
if [ "$SCAN_CODE" -eq 0 ]; then ok "違反 0 件"; else ng "実コードで違反が出た" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "conditional-skips=[1-9]"; then
  ok "条件つき skip を実際に数えている（空振りでない）"
else
  ng "条件つき skip が 0 件（走査が壊れている疑い）" "$SCAN_OUT"
fi
if printf '%s' "$SCAN_OUT" | grep -q "describes=[1-9]"; then
  ok "describe を実際に数えている"
else
  ng "describe が 0 件" "$SCAN_OUT"
fi

echo "=== scenario 2: 今日の実例と同じ形で落ちる（RED 方向） ==="
BAD="$WORK/bad"
mkdir -p "$BAD"
cat > "$BAD/attack.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

const fixtures = readFixtures()

test.describe('他施設ユーザーによる API Route 直接攻撃の総当たり [P-017]', () => {
  test.skip(!fixtures || !fixtures.loanOrderId, 'cross-facility フィクスチャが無い')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定')

  test('攻撃表は実在する route と過不足なく対応する（ratchet）', () => {
    expect(missing).toEqual([])
  })

  test('全 route を叩いても施設 A のデータは変わらない', async ({ baseURL }) => {
    expect(baseURL).toBeTruthy()
  })
})
TS
ALLOW_ZERO= run_scan "$BAD"
if [ "$SCAN_CODE" -ne 0 ]; then ok "落ちる"; else ng "同じ形なのに通った" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "violations=1"; then
  ok "違反はちょうど 1 件（同期テストだけを数える）"
else
  ng "違反件数が 1 件でない" "$SCAN_OUT"
fi
if printf '%s' "$SCAN_OUT" | grep -q "ratchet"; then
  ok "どのテストが巻き込まれているかを名指しする"
else
  ng "テスト名を出さない" "$SCAN_OUT"
fi
if printf '%s' "$SCAN_OUT" | grep -q "前提 2 件"; then
  ok "効いている前提を全部数える（1 つ外しても直らないことが分かる）"
else
  ng "前提の件数を出さない" "$SCAN_OUT"
fi
if printf '%s' "$SCAN_OUT" | grep -q "SUPABASE_SERVICE_ROLE_KEY"; then
  ok "2 つ目の前提も名指しする"
else
  ng "2 つ目の前提を出さない" "$SCAN_OUT"
fi

echo "=== scenario 3: 前提が要るテスト（async）は落とさない（対照） ==="
ASYNC_ONLY="$WORK/async-only"
mkdir -p "$ASYNC_ONLY"
cat > "$ASYNC_ONLY/a.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('DB が要るテストだけ', () => {
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, '鍵が無い')

  test('実 DB を読む', async () => {
    const rows = await readRows()
    expect(rows).toBeTruthy()
  })

  test('画面を開く', async ({ page }) => {
    await page.goto('/')
  })
})
TS
ALLOW_ZERO= run_scan "$ASYNC_ONLY"
if [ "$SCAN_CODE" -eq 0 ]; then ok "async のテストは巻き込みと見なさない"; else ng "async を誤検知した" "$SCAN_OUT"; fi

echo "=== scenario 4: 前提の無い describe の同期テストは落とさない（対照） ==="
NO_SKIP="$WORK/no-skip"
mkdir -p "$NO_SKIP"
cat > "$NO_SKIP/b.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('前提なし', () => {
  test('同期の検査', () => {
    expect(1).toBe(1)
  })
})

test.describe('こちらには前提がある', () => {
  test.skip(!process.env.KEY, '鍵が無い')

  test('DB を読む', async () => {
    expect(await readRows()).toBeTruthy()
  })
})
TS
ALLOW_ZERO= run_scan "$NO_SKIP"
if [ "$SCAN_CODE" -eq 0 ]; then ok "前提の無い describe は対象外"; else ng "前提の無い describe を誤検知した" "$SCAN_OUT"; fi

echo "=== scenario 5: 逃がし口（理由つき）が効く ==="
EXEMPT="$WORK/exempt"
mkdir -p "$EXEMPT"
cat > "$EXEMPT/c.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('逃がす', () => {
  test.skip(!process.env.KEY, '鍵が無い')

  // skip-scope-ok: この spec でしか意味を持たない整合検査なので、ここに置く
  test('同じ行の上に理由がある', () => {
    expect(1).toBe(1)
  })

  test('同じ行に理由がある', () => { // skip-scope-ok: 上と同じ理由
    expect(1).toBe(1)
  })
})
TS
ALLOW_ZERO= run_scan "$EXEMPT"
if [ "$SCAN_CODE" -eq 0 ]; then ok "理由つきの逃がし口は通す"; else ng "逃がし口が効かない" "$SCAN_OUT"; fi

echo "=== scenario 6: 理由の無い逃がし口は効かない ==="
NO_REASON="$WORK/no-reason"
mkdir -p "$NO_REASON"
cat > "$NO_REASON/d.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('理由なし', () => {
  test.skip(!process.env.KEY, '鍵が無い')

  // skip-scope-ok:
  test('理由が空', () => {
    expect(1).toBe(1)
  })
})
TS
ALLOW_ZERO= run_scan "$NO_REASON"
if [ "$SCAN_CODE" -ne 0 ]; then ok "理由が空の印では逃がさない"; else ng "理由なしで通した" "$SCAN_OUT"; fi

echo "=== scenario 7: 条件なしの test.skip() は前提として数えない ==="
BARE="$WORK/bare"
mkdir -p "$BARE"
cat > "$BARE/e.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('条件なしのスキップ', () => {
  test('自分だけスキップする', () => {
    test.skip()
    expect(1).toBe(1)
  })
})
TS
ALLOW_ZERO=1 run_scan "$BARE"
if [ "$SCAN_CODE" -eq 0 ]; then ok "条件なしの skip は describe の前提と見なさない"; else ng "条件なしを誤検知した" "$SCAN_OUT"; fi

echo "=== scenario 8: 走査が空振りしたら合格にしない（fail-open 防止） ==="
EMPTY="$WORK/empty"
mkdir -p "$EMPTY"
ALLOW_ZERO= run_scan "$EMPTY"
if [ "$SCAN_CODE" -ne 0 ]; then ok "spec が 0 本なら落ちる"; else ng "spec 0 本で通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "1 本も見つけられなかった"; then
  ok "走査が壊れていると言う"
else
  ng "空振りの理由を出さない" "$SCAN_OUT"
fi

NO_COND="$WORK/no-cond"
mkdir -p "$NO_COND"
cat > "$NO_COND/f.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('条件つきスキップがどこにも無い', () => {
  test('ふつうの検査', () => {
    expect(1).toBe(1)
  })
})
TS
ALLOW_ZERO= run_scan "$NO_COND"
if [ "$SCAN_CODE" -ne 0 ]; then ok "条件つき skip が 0 件なら落ちる"; else ng "0 件で通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "走査が壊れている疑い"; then
  ok "探し方が変わった合図だと言う"
else
  ng "疑いを出さない" "$SCAN_OUT"
fi
ALLOW_ZERO=1 run_scan "$NO_COND"
if [ "$SCAN_CODE" -eq 0 ]; then ok "本当に 0 件のときは環境変数で明示できる"; else ng "明示しても落ちる" "$SCAN_OUT"; fi

echo "=== scenario 9: describe の入れ子でも外側の前提を見る ==="
NESTED="$WORK/nested"
mkdir -p "$NESTED"
cat > "$NESTED/g.spec.ts" <<'TS'
import { test, expect } from '@playwright/test'

test.describe('外側', () => {
  test.skip(!process.env.KEY, '鍵が無い')

  test.describe('内側', () => {
    test('前提の要らない同期検査', () => {
      expect(1).toBe(1)
    })
  })
})
TS
ALLOW_ZERO= run_scan "$NESTED"
if [ "$SCAN_CODE" -ne 0 ]; then ok "入れ子の内側も外側の前提に巻き込まれると見る"; else ng "入れ子を見落とした" "$SCAN_OUT"; fi

if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "FAILED"; fi
exit "$fail"
