#!/bin/bash
# WHY: docs/agents/human-bypass-inventory.md（人間系の回避経路、H-xxx。issue #757 の 33）の形を固定し、
#      その中で機械的に止められる 1 つ（H-012: テストを黙らせる）を実際に止める。
#   (a) 6 列・ID 規約（H-3 桁、重複なし）・状態 4 語（記録される / 一部 / 記録されない / 不可）
#   (b) 「記録されない」「一部」の行は手続き列に log-manual-override.sh か #757-N への導線がある
#   (c) src/ supabase/ e2e/ scripts/ に it.only / test.only / describe.only が無い
#   (d) src/ supabase/ の unit・統合テストに無条件の it.skip / describe.skip が無い
#       （e2e の test.skip(条件, '理由') は許す。scripts/eval-fixtures は意図的な fixture なので対象外）
#   (e) fixture で (a)(b) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-human-bypass-inventory.test.sh
# 環境変数（テスト用注入ポイント）: HUMAN_BYPASS_INVENTORY_PATH / HUMAN_BYPASS_SCAN_ROOT
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="${HUMAN_BYPASS_INVENTORY_PATH:-$REPO_ROOT/docs/agents/human-bypass-inventory.md}"
SCAN_ROOT="${HUMAN_BYPASS_SCAN_ROOT:-$REPO_ROOT}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

check_inventory() {
  local file="$1" violations=0 line id nf status procedure seen=""
  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 8 ]; then
      echo "    columns: [$id] 列数が6列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi
    if ! grep -qE '^H-[0-9]{3}$' <<<"$id"; then
      echo "    id: [$id] ID が H-3桁でない"
      violations=$((violations+1))
    fi
    if grep -qx "$id" <<<"$seen"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen="$(printf '%s\n%s' "$seen" "$id")"
    procedure="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$6); print $6}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"
    case "$status" in
      記録される|不可) ;;
      一部|記録されない)
        if ! grep -qE 'log-manual-override|--safeguard|#757-[0-9]+' <<<"$procedure"; then
          echo "    procedure: [$id] $status なのに手動記録（--safeguard）か #757-N への導線が無い"
          violations=$((violations+1))
        fi
        ;;
      *) echo "    status: [$id] 状態が4語以外: '$status'"; violations=$((violations+1)) ;;
    esac
  done < <(grep '^| H-' "$file" || true)
  echo "violations=$violations"
}

# (c) .only の残存。$1=走査ルート
scan_only() {
  grep -rn -e "it.only(" -e "test.only(" -e "describe.only(" "$1/src" "$1/supabase" "$1/e2e" "$1/scripts" 2>/dev/null \
    | grep -v "scripts/check-human-bypass-inventory.test.sh" | grep -v "scripts/eval-fixtures/" || true
}
# (d) unit・統合テストの無条件 skip。$1=走査ルート
scan_skip() {
  grep -rn -e "it.skip(" -e "describe.skip(" -e "test.skip(" "$1/src" "$1/supabase" 2>/dev/null || true
}

echo "=== scenario 1: 棚卸しの表に違反が無い ==="
RESULT="$(check_inventory "$INVENTORY")"
if [ "$(tail -n1 <<<"$RESULT")" = "violations=0" ]; then
  assert_ok "違反なし（$(grep -c '^| H-' "$INVENTORY" || echo 0) 行）"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 2: テストを黙らせる経路（H-012）が無い ==="
ONLY="$(scan_only "$SCAN_ROOT")"
if [ -z "$ONLY" ]; then assert_ok ".only なし"; else assert_fail ".only が残っている（他のテストが回らない）" "$ONLY"; fi
SKIP="$(scan_skip "$SCAN_ROOT")"
if [ -z "$SKIP" ]; then assert_ok "src/ supabase/ に無条件 skip なし"; else assert_fail "無条件 skip がある（理由付き issue と it.todo か条件付き skip にする）" "$SKIP"; fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/inventory.md" <<'EOF'
| H-900 | 正常 | x | y | `--safeguard H-900` で残す | 記録されない |
| H-901 | 正常（記録される） | x | y | 手続き不要 | 記録される |
| H-902 | 導線なし | x | y | 気をつける | 一部 |
| H-903 | 状態が変 | x | y | z | たぶん記録 |
| H-12 | 桁不足 | x | y | z | 不可 |
| H-900 | 重複 | x | y | z | 不可 |
| H-904 | 列ずれ | x | y | 不可 |
EOF
RESULT="$(check_inventory "$WORK/inventory.md")"
EXPECTED=5
if [ "$(tail -n1 <<<"$RESULT")" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（${EXPECTED}）と異なる" "$RESULT"
fi
for needle in 'procedure: \[H-902\]' 'status: \[H-903\]' 'id: \[H-12\]' 'id: \[H-900\] ID が重複' 'columns: \[H-904\]'; do
  if grep -qE "$needle" <<<"$RESULT"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done

mkdir -p "$WORK/src/__tests__" "$WORK/supabase/__tests__" "$WORK/e2e" "$WORK/scripts"
printf "it.only('x', () => {})\n" > "$WORK/src/__tests__/a.test.ts"
printf "describe.skip('y', () => {})\n" > "$WORK/supabase/__tests__/b.test.ts"
printf "test.skip(!fixtures, '理由')\n" > "$WORK/e2e/c.spec.ts"
ONLY="$(scan_only "$WORK")"
SKIP="$(scan_skip "$WORK")"
if grep -q 'a.test.ts' <<<"$ONLY"; then assert_ok ".only を検知"; else assert_fail ".only を検知できない" "$ONLY"; fi
if grep -q 'b.test.ts' <<<"$SKIP"; then assert_ok "無条件 skip を検知"; else assert_fail "無条件 skip を検知できない" "$SKIP"; fi
if grep -q 'c.spec.ts' <<<"$SKIP"; then assert_fail "e2e の条件付き skip を誤検知" "$SKIP"; else assert_ok "e2e の条件付き skip は対象外"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
