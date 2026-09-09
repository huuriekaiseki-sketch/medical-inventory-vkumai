#!/bin/bash
# WHY: docs/agents/access-path-inventory.md（代替経路の棚卸し、X-xxx。issue #757 の 26）の形を固定する
#      構造テスト。他のカタログ（P / I / T / F / D / H）と同じ型:
#   (a) 8 列・ID 規約（X-3 桁、重複なし）・状態 4 語（検査あり / 一部 / 未 / 対象外）
#   (b) 「どの鍵で」列は「鍵の所在」表にある鍵の名前だけを使う（鍵の所在と一致させる）
#   (c) 「未」の行は #757-N を必ず書く
#   (d) 参照する P-xxx / I-xxx が各カタログに実在する（消した約束を参照し続けない）
#   (e) fixture で (a)〜(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-access-path-inventory.test.sh
# 環境変数（テスト用注入ポイント）: ACCESS_PATH_INVENTORY_PATH / PROMISE_CATALOG_PATH / INVARIANT_CATALOG_PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="${ACCESS_PATH_INVENTORY_PATH:-$REPO_ROOT/docs/agents/access-path-inventory.md}"
PROMISES="${PROMISE_CATALOG_PATH:-$REPO_ROOT/docs/agents/promise-catalog.md}"
INVARIANTS="${INVARIANT_CATALOG_PATH:-$REPO_ROOT/docs/agents/invariant-catalog.md}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

catalog_ids() { grep -oE "^\| $2-[0-9]{3} " "$1" | grep -oE "$2-[0-9]{3}" | sort -u; }
# 「鍵の所在」表の 1 列目（鍵の名前）
key_names() {
  awk -F'|' '/^## 鍵の所在/{f=1; next} /^## /{f=0} f && /^\| / && $2 !~ /^ *-+ *$/ && $2 !~ /^ *鍵 *$/ {gsub(/^ +| +$/,"",$2); print $2}' "$1"
}

check_inventory() {
  local file="$1" promises="$2" invariants="$3" violations=0
  local line id nf status key tests seen="" p_ids i_ids ref keys k hit
  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi
  p_ids="$(catalog_ids "$promises" P)"
  i_ids="$(catalog_ids "$invariants" I)"
  keys="$(key_names "$file")"

  for ref in $(grep '^| X-' "$file" | grep -oE '[PI]-[0-9]{3}' | sort -u); do
    case "$ref" in
      P-*) printf '%s\n' "$p_ids" | grep -qx "$ref" || { echo "    stale: [$ref] 約束カタログに無い ID を参照"; violations=$((violations+1)); } ;;
      I-*) printf '%s\n' "$i_ids" | grep -qx "$ref" || { echo "    stale: [$ref] 不変条件カタログに無い ID を参照"; violations=$((violations+1)); } ;;
    esac
  done

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 10 ]; then
      echo "    columns: [$id] 列数が8列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi
    if ! printf '%s' "$id" | grep -qE '^X-[0-9]{3}$'; then
      echo "    id: [$id] ID が X-3桁でない"
      violations=$((violations+1))
    fi
    if printf '%s\n' "$seen" | grep -qx "$id"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen="$(printf '%s\n%s' "$seen" "$id")"
    key="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$5); print $5}')"
    tests="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$8); print $8}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$9); print $9}')"
    case "$status" in
      検査あり|一部|対象外) ;;
      未*)
        if ! printf '%s' "$status$tests" | grep -qE '#757-[0-9]+'; then
          echo "    plan: [$id] 未 なのに #757-N が無い"
          violations=$((violations+1))
        fi
        ;;
      *) echo "    status: [$id] 状態が4語以外: '$status'"; violations=$((violations+1)) ;;
    esac
    # 鍵の語彙: "—" か、鍵の所在表の名前を 1 つ以上含む
    if [ "$key" != "—" ]; then
      hit=0
      while IFS= read -r k; do
        [ -n "$k" ] || continue
        case "$key" in *"$k"*) hit=1 ;; esac
      done <<< "$keys"
      if [ "$hit" -eq 0 ]; then
        echo "    key: [$id] 「どの鍵で」が鍵の所在表の名前を含まない: '$key'"
        violations=$((violations+1))
      fi
    fi
  done < <(grep '^| X-' "$file" || true)
  echo "violations=$violations"
}

echo "=== scenario 1: 実態の表に違反が無い ==="
RESULT="$(check_inventory "$INVENTORY" "$PROMISES" "$INVARIANTS")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし（$(grep -c '^| X-' "$INVENTORY" || echo 0) 経路、鍵 $(key_names "$INVENTORY" | grep -c . || echo 0) 種）"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/promises.md" <<'EOF'
| P-900 | 約束 | a | b | c | d | e | `x` | 変更時 |
EOF
cat > "$WORK/invariants.md" <<'EOF'
| I-900 | 不変条件 | a | b | c | `x` | 実装済み |
EOF
cat > "$WORK/inventory.md" <<'EOF'
## 鍵の所在

| 鍵 | 誰が持つか | どこにあるか | 漏れたときの到達範囲 |
| --- | --- | --- | --- |
| anon key | 全員 | env | 無し |
| service_role key | サーバー | env | 全部 |

## 一覧

| X-900 | 正常 | 利用者 | anon key | 読む | RLS | P-900、I-900 | 検査あり |
| X-901 | 正常（未に計画） | 開発者 | service_role key | 全部 | 監査 | 未（#757-24） | 未（#757-24） |
| X-902 | 未に計画なし | 開発者 | service_role key | 全部 | 監査 | 未 | 未 |
| X-903 | 鍵の語彙外 | 開発者 | 魔法の鍵 | 全部 | 監査 | P-900 | 一部 |
| X-904 | 存在しない ID | 開発者 | anon key | 読む | RLS | P-999 | 検査あり |
| X-905 | 状態が変 | 開発者 | anon key | 読む | RLS | P-900 | たぶん |
| X-12 | 桁不足 | 開発者 | anon key | 読む | RLS | P-900 | 対象外 |
| X-900 | 重複 | 開発者 | anon key | 読む | RLS | P-900 | 対象外 |
| X-906 | 列ずれ | 開発者 | anon key | 読む | P-900 | 対象外 |
| X-907 | 鍵なし | — | — | 機能なし | — | 対象外 | 対象外 |
EOF
RESULT="$(check_inventory "$WORK/inventory.md" "$WORK/promises.md" "$WORK/invariants.md")"
EXPECTED=7
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（${EXPECTED}）と異なる" "$RESULT"
fi
for needle in 'plan: \[X-902\]' 'key: \[X-903\]' 'stale: \[P-999\]' 'status: \[X-905\]' 'id: \[X-12\]' 'id: \[X-900\] ID が重複' 'columns: \[X-906\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q -e 'X-901' -e 'X-907'; then assert_fail "正常行を誤検知" "$RESULT"; else assert_ok "計画付きの未・鍵なしの対象外は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
