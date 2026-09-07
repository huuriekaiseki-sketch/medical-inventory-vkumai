#!/usr/bin/env bash
# WHY: issue #757 の 32（quota-inventory の Q-002、約束カタログ P-064）。回数の上限は requireAuth の中で数える。
#      route ごとに書くと必ずどれかが抜けるので、抜けを機械で見つける。
#      2026-09-07 の点検では、24 本ある API のうち**1 本も**上限を持っていなかった。
#
#   (a) requireAuth を呼ぶ route は、その catch で authGuardError を使う
#       （使わないと「上限を超えた」が 401 になって、原因が分からなくなる）
#   (b) 上限の値がコードに直接書かれていない（aidd.config.json の limits から読む）
#   (c) requireAuth 自体が上限を消費している（消費をやめたら気づく）
#   (d) fixture で (a) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-rate-limit-coverage.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/src/app/api"
REQUIRE_AUTH="$REPO_ROOT/src/lib/supabase/require-auth.ts"
RATE_LIMIT="$REPO_ROOT/src/lib/security/rate-limit.ts"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# requireAuth を呼ぶのに authGuardError を通していない route を列挙する
scan_routes() {
  local dir="$1"
  local out=""
  while IFS= read -r f; do
    grep -q 'requireAuth(' "$f" || continue
    if ! grep -q 'authGuardError' "$f"; then
      out="$out
${f#"$dir"/}"
    fi
  done < <(find "$dir" -name 'route.ts' -type f 2>/dev/null)
  printf '%s' "${out# }"
}

echo "=== scenario 1: requireAuth を使う route はすべて authGuardError を通している ==="
MISSING="$(scan_routes "$API_DIR")"
COUNT="$(find "$API_DIR" -name 'route.ts' -type f -exec grep -l 'requireAuth(' {} + 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -lt 10 ]; then
  assert_fail "走査対象の route が少なすぎる（$COUNT 本）。走査が壊れている疑い（fail-open 防止）"
elif [ -z "$MISSING" ]; then
  assert_ok "$COUNT 本すべてが authGuardError を通している"
else
  assert_fail "上限超過を 401 のまま返す route がある" "$MISSING
      catch (e) { return authGuardError(e) } に直す（src/lib/api-error.ts）"
fi

echo "=== scenario 2: requireAuth が上限を消費している ==="
if grep -q 'consumeUserRequestQuota' "$REQUIRE_AUTH" 2>/dev/null; then
  assert_ok "requireAuth が回数を数えている"
else
  assert_fail "requireAuth が上限を数えていない" "src/lib/supabase/require-auth.ts"
fi
if grep -q "RATE_LIMITED" "$REQUIRE_AUTH" 2>/dev/null; then
  assert_ok "上限超過は RATE_LIMITED で止まる"
else
  assert_fail "requireAuth が RATE_LIMITED を投げていない"
fi

echo "=== scenario 3: 上限の値がコードに直書きされていない ==="
if grep -q 'aidd.config.json' "$RATE_LIMIT" 2>/dev/null; then
  assert_ok "値は設定（aidd.config.json の limits）から読む"
else
  assert_fail "上限の値が設定から読まれていない" "リポジトリごとに違う値をコードに書かない"
fi
if grep -qE 'REQUESTS_PER_MINUTE(: *number)? *= *[0-9]' "$RATE_LIMIT" 2>/dev/null; then
  assert_fail "上限の値が数字で直書きされている" "$RATE_LIMIT"
else
  assert_ok "上限が数字で直書きされていない"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/good" "$WORK/bad"
cat > "$WORK/good/route.ts" <<'EOF'
import { authGuardError } from '@/lib/api-error'
export async function GET() {
  try { await requireAuth(db) } catch (e) { return authGuardError(e) }
}
EOF
cat > "$WORK/bad/route.ts" <<'EOF'
import { apiError } from '@/lib/api-error'
export async function GET() {
  try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
}
EOF
OUT="$(scan_routes "$WORK")"
if printf '%s' "$OUT" | grep -q 'bad/route.ts'; then assert_ok "抜けている route を検知"; else assert_fail "抜けを検知できない" "$OUT"; fi
if printf '%s' "$OUT" | grep -q 'good/route.ts'; then assert_fail "正しい route を違反にした" "$OUT"; else assert_ok "正しい route は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
