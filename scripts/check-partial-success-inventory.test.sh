#!/bin/bash
# WHY: docs/agents/partial-success-inventory.md（部分成功の棚卸し、M-xxx。issue #757 の 38）の形を固定する
#      構造テスト。他のカタログ（P / I / T / F / D / H / X）と同じ型:
#   (a) 7 列・ID 規約（M-3 桁、重複なし）・状態 4 語（原子的 / 収束する / 中間状態あり / 未確認）
#   (b) 「中間状態あり」「未確認」の行は #757-N を必ず書く（放置しない）
#   (c) 「原子的」「収束する」の行は守るテストにパスがある（未 は不可。中間状態が無いことは実測で言う）
#   (d) 守るテスト列のバッククォートのパスが実在する
#   (e) fixture で (a)〜(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-partial-success-inventory.test.sh
# 環境変数（テスト用注入ポイント）: PARTIAL_SUCCESS_INVENTORY_PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="${PARTIAL_SUCCESS_INVENTORY_PATH:-$REPO_ROOT/docs/agents/partial-success-inventory.md}"

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
    if ! printf '%s' "$id" | grep -qE '^M-[0-9]{3}$'; then
      echo "    id: [$id] ID が M-3桁でない"
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
      原子的|収束する)
        if ! printf '%s' "$tests" | grep -q '`'; then
          echo "    evidence: [$id] $status なのに守るテストが無い"
          violations=$((violations+1))
        fi
        ;;
      中間状態あり*|未確認*)
        if ! printf '%s' "$status" | grep -qE '#757-[0-9]+'; then
          echo "    plan: [$id] ${status%%（*} なのに #757-N が無い"
          violations=$((violations+1))
        fi
        ;;
      *) echo "    status: [$id] 状態が4語以外: '$status'"; violations=$((violations+1)) ;;
    esac
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
  done < <(grep '^| M-' "$file" || true)
  echo "violations=$violations"
}

echo "=== scenario 1: 表が存在し、行が1つ以上ある ==="
if [ -f "$INVENTORY" ]; then assert_ok "存在する: $INVENTORY"; else assert_fail "存在しない: $INVENTORY"; fi
ROWS="$(grep -c '^| M-' "$INVENTORY" 2>/dev/null || echo 0)"
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
| M-900 | 正常（原子的） | x | y | z | `package.json` | 原子的 |
| M-901 | 正常（未確認に計画あり） | x | y | z | 未 | 未確認（#757-38） |
| M-902 | 未確認に計画なし | x | y | z | 未 | 未確認 |
| M-903 | 収束するのにテストなし | x | y | z | 未 | 収束する |
| M-904 | 状態が変 | x | y | z | 未 | たぶん原子的 |
| M-905 | 不在パス | x | y | z | `scripts/no-such.sh` | 原子的 |
| M-906 | 中間状態ありに計画なし | x | y | z | 未 | 中間状態あり |
| M-12 | 桁不足 | x | y | z | `package.json` | 収束する |
| M-900 | 重複 | x | y | z | `package.json` | 収束する |
| M-907 | 列ずれ | x | y | `package.json` | 原子的 |
EOF
RESULT="$(check_inventory "$WORK/inventory.md")"
EXPECTED=8
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in 'plan: \[M-902\]' 'evidence: \[M-903\]' 'status: \[M-904\]' 'path: \[M-905\]' 'plan: \[M-906\]' 'id: \[M-12\]' 'id: \[M-900\] ID が重複' 'columns: \[M-907\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'M-901'; then assert_fail "計画付きの未確認を誤検知" "$RESULT"; else assert_ok "計画付きの未確認は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
