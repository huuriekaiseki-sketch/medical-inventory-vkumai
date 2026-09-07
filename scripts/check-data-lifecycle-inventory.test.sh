#!/bin/bash
# WHY: docs/agents/data-lifecycle-inventory.md（データの残存先、D-xxx。issue #757 の 28）の形を固定する
#      構造テスト。他のカタログ（P / I / T / F）と同じ型:
#   (a) 7 列・ID 規約（D-3 桁、重複なし）・状態 4 語
#   (b) 「未確認」の行は #757-N を必ず書く（確認しない未確認を残さない）
#   (c) 「消える」の行は守るテストにパスがある（未 は不可）
#   (d) 守るテスト列のバッククォートのパスが実在する
#   (e) fixture で (a)〜(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-data-lifecycle-inventory.test.sh
# 環境変数（テスト用注入ポイント）: DATA_LIFECYCLE_INVENTORY_PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="${DATA_LIFECYCLE_INVENTORY_PATH:-$REPO_ROOT/docs/agents/data-lifecycle-inventory.md}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 検査本体。$1=表。末尾行に violations=N
check_inventory() {
  local file="$1" violations=0 line id nf status tests seen="" p
  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 9 ]; then
      echo "    columns: [$id] 列数が7列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi
    if ! printf '%s' "$id" | grep -qE '^D-[0-9]{3}$'; then
      echo "    id: [$id] ID が D-3桁でない"
      violations=$((violations+1))
    fi
    if printf '%s\n' "$seen" | grep -qx "$id"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen="$(printf '%s\n%s' "$seen" "$id")"
    tests="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$8); print $8}')"
    case "$status" in
      消える|残らない|"残る（意図）") ;;
      未確認*)
        if ! printf '%s' "$status" | grep -qE '#757-[0-9]+'; then
          echo "    plan: [$id] 未確認 なのに #757-N が無い"
          violations=$((violations+1))
        fi
        ;;
      *) echo "    status: [$id] 状態が4語以外: '$status'"; violations=$((violations+1)) ;;
    esac
    if [ "$status" = "消える" ] && ! printf '%s' "$tests" | grep -q '`'; then
      echo "    evidence: [$id] 消える なのに守るテストが無い"
      violations=$((violations+1))
    fi
    for p in $(printf '%s' "$tests" | grep -o '`[][A-Za-z0-9_./-]*`' | tr -d '`'); do
      case "$p" in
        */|*.ts|*.tsx|*.sh|*.md|*.sql)
          if [ ! -e "$REPO_ROOT/$p" ]; then
            echo "    path: [$id] 守るテストのパスが存在しない: $p"
            violations=$((violations+1))
          fi
          ;;
      esac
    done
  done < <(grep '^| D-' "$file" || true)
  echo "violations=$violations"
}

echo "=== scenario 1: 表が存在し、行が1つ以上ある ==="
if [ -f "$INVENTORY" ]; then assert_ok "存在する: $INVENTORY"; else assert_fail "存在しない: $INVENTORY"; fi
ROWS="$(grep -c '^| D-' "$INVENTORY" 2>/dev/null || echo 0)"
if [ "$ROWS" -ge 1 ]; then assert_ok "行数 $ROWS"; else assert_fail "行が 0"; fi

echo "=== scenario 2: 実態の表に違反が無い ==="
RESULT="$(check_inventory "$INVENTORY")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 3: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/inventory.md" <<'EOF'
| D-900 | 正常 | x | y | z | `package.json` | 消える |
| D-901 | 正常（未確認に計画あり） | x | y | z | 未 | 未確認（#757-28） |
| D-902 | 未確認に計画なし | x | y | z | 未 | 未確認 |
| D-903 | 消えるのにテストなし | x | y | z | 未 | 消える |
| D-904 | 状態が変 | x | y | z | 未 | たぶん消える |
| D-905 | 不在パス | x | y | z | `scripts/no-such.sh` | 消える |
| D-12 | 桁不足 | x | y | z | 未 | 残らない |
| D-900 | 重複 | x | y | z | 未 | 残らない |
| D-906 | 列ずれ | x | y | 未 | 残らない |
EOF
RESULT="$(check_inventory "$WORK/inventory.md")"
EXPECTED=7
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in 'plan: \[D-902\]' 'evidence: \[D-903\]' 'status: \[D-904\]' 'path: \[D-905\]' 'id: \[D-12\]' 'id: \[D-900\] ID が重複' 'columns: \[D-906\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'D-901'; then assert_fail "計画付きの未確認を誤検知" "$RESULT"; else assert_ok "計画付きの未確認は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
