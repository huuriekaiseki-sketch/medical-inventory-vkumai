#!/bin/bash
# WHY: docs/agents/blast-radius.md（乗っ取り後の到達範囲、B-xxx。issue #757 の 39）の形を固定する
#      構造テスト。他のカタログ（P / I / T / F / D / H / X / M）と同じ型:
#   (a) 7 列・ID 規約（B-3 桁、重複なし）・状態 4 語（限定済み / 広い（意図）/ 要縮小 / 未測定）
#   (b) 「要縮小」「未測定」の行は #757-N を必ず書く（広いまま放置しない）
#   (c) 「限定済み」の行は止めるもの列にパスがある（未 は不可。狭いことは実測で言う）
#   (d) 止めるもの列のバッククォートのパスが実在する
#   (e) fixture で (a)〜(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-blast-radius.test.sh
# 環境変数（テスト用注入ポイント）: BLAST_RADIUS_PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="${BLAST_RADIUS_PATH:-$REPO_ROOT/docs/agents/blast-radius.md}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

check_inventory() {
  local file="$1" violations=0 line id nf status stops seen="" p
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
    if ! printf '%s' "$id" | grep -qE '^B-[0-9]{3}$'; then
      echo "    id: [$id] ID が B-3桁でない"
      violations=$((violations+1))
    fi
    if printf '%s\n' "$seen" | grep -qx "$id"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen="$(printf '%s\n%s' "$seen" "$id")"
    stops="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$8); print $8}')"
    case "$status" in
      限定済み)
        if ! printf '%s' "$stops" | grep -q '`'; then
          echo "    evidence: [$id] 限定済み なのに止めるものが無い"
          violations=$((violations+1))
        fi
        ;;
      "広い（意図）") ;;
      要縮小*|未測定*)
        if ! printf '%s' "$status" | grep -qE '#757-[0-9]+'; then
          echo "    plan: [$id] ${status%%（*} なのに #757-N が無い"
          violations=$((violations+1))
        fi
        ;;
      *) echo "    status: [$id] 状態が4語以外: '$status'"; violations=$((violations+1)) ;;
    esac
    for p in $(printf '%s' "$stops" | grep -o '`[][A-Za-z0-9_./-]*`' | tr -d '`'); do
      case "$p" in
        */|*.ts|*.tsx|*.sh|*.md|*.sql)
          if [ ! -e "$REPO_ROOT/$p" ]; then
            echo "    path: [$id] 止めるもののパスが存在しない: $p"
            violations=$((violations+1))
          fi
          ;;
      esac
    done
  done < <(grep '^| B-' "$file" || true)
  echo "violations=$violations"
}

echo "=== scenario 1: 表が存在し、行が1つ以上ある ==="
if [ -f "$INVENTORY" ]; then assert_ok "存在する: $INVENTORY"; else assert_fail "存在しない: $INVENTORY"; fi
ROWS="$(grep -c '^| B-' "$INVENTORY" 2>/dev/null || echo 0)"
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
| B-900 | 正常（限定済み） | x | y | z | `package.json` | 限定済み |
| B-901 | 正常（広いが意図） | x | y | z | 未 | 広い（意図） |
| B-902 | 要縮小に計画なし | x | y | z | 未 | 要縮小 |
| B-903 | 限定済みなのに根拠なし | x | y | z | 未 | 限定済み |
| B-904 | 状態が変 | x | y | z | 未 | たぶん限定 |
| B-905 | 不在パス | x | y | z | `scripts/no-such.sh` | 限定済み |
| B-906 | 未測定に計画なし | x | y | z | 未 | 未測定 |
| B-12 | 桁不足 | x | y | z | `package.json` | 限定済み |
| B-900 | 重複 | x | y | z | `package.json` | 限定済み |
| B-907 | 列ずれ | x | y | `package.json` | 限定済み |
EOF
RESULT="$(check_inventory "$WORK/inventory.md")"
EXPECTED=8
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in 'plan: \[B-902\]' 'evidence: \[B-903\]' 'status: \[B-904\]' 'path: \[B-905\]' 'plan: \[B-906\]' 'id: \[B-12\]' 'id: \[B-900\] ID が重複' 'columns: \[B-907\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'B-901'; then assert_fail "広い（意図）を誤検知" "$RESULT"; else assert_ok "広い（意図）は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
