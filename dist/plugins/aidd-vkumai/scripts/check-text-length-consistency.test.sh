#!/usr/bin/env bash
# WHY: issue #757 の 20。文字数の上限は 3 か所に現れる。
#        (1) 人が決めた値      aidd.config.json の limits.textLength
#        (2) 最後の防波堤      supabase/migrations の CHECK 制約
#        (3) 入口での早い拒否  src/lib/validation/ の zod スキーマ
#      同じ数字が 3 か所に散ると必ずずれる。2026-09-07 の突合では実際にずれていて、
#      **DB にあるのに人が決めていない項目が 3 つ**（医師名・使用期限・仕入先）見つかった。
#
#   (a) DB の CHECK に出てくる上限値が、すべて設定の値のどれかと一致する
#   (b) 設定の項目がすべて zod スキーマから使われている（決めたのに使っていない、が無い）
#   (c) zod スキーマに数字が直接書かれていない（設定から読む）
#   (d) fixture で (a)(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-text-length-consistency.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/aidd.config.json"
MIGRATION="$REPO_ROOT/supabase/migrations/20260907000004_add_text_length_limits.sql"
SCHEMAS="$REPO_ROOT/src/lib/validation/schemas.ts"
LIMITS_TS="$REPO_ROOT/src/lib/validation/text-limits.ts"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 設定の値の一覧（重複を除く）
config_values() {
  node -e '
const fs = require("fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const values = Object.values(cfg.limits?.textLength ?? {})
console.log([...new Set(values)].sort((a, b) => a - b).join(" "))
' "$1"
}

# 設定のキーの一覧
config_keys() {
  node -e '
const fs = require("fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
console.log(Object.keys(cfg.limits?.textLength ?? {}).join(" "))
' "$1"
}

# migration の CHECK に現れる length(...) <= N の N
migration_values() {
  grep -oE 'length\([a-z_]+\) <= [0-9]+' "$1" 2>/dev/null | grep -oE '[0-9]+$' | sort -un | tr '\n' ' '
}

echo "=== scenario 1: 3 つのファイルが揃っている（fail-open 防止） ==="
missing=""
for f in "$CONFIG" "$MIGRATION" "$SCHEMAS" "$LIMITS_TS"; do
  [ -f "$f" ] || missing="$missing $f"
done
if [ -z "$missing" ]; then
  assert_ok "設定・migration・スキーマがすべてある"
else
  assert_fail "突合に必要なファイルが無い" "$missing"
fi

echo "=== scenario 2: DB の上限値がすべて人の決めた値のどれかと一致する ==="
CONFIG_VALUES=" $(config_values "$CONFIG") "
DB_VALUES="$(migration_values "$MIGRATION")"
if [ -z "$DB_VALUES" ]; then
  assert_fail "migration から上限値を 1 つも読めない（走査が壊れている疑い）"
else
  orphan=""
  for v in $DB_VALUES; do
    case "$CONFIG_VALUES" in
      *" $v "*) ;;
      *) orphan="$orphan $v" ;;
    esac
  done
  if [ -z "$orphan" ]; then
    assert_ok "DB の上限値（$DB_VALUES）はすべて設定にある"
  else
    assert_fail "DB にあるのに人が決めていない上限値がある" "$orphan
      aidd.config.json の limits.textLength に項目を足すか、DB の CHECK を直す"
  fi
fi

echo "=== scenario 3: 決めた項目がすべて zod スキーマから使われている ==="
unused=""
for k in $(config_keys "$CONFIG"); do
  if ! grep -q "'$k'" "$SCHEMAS" 2>/dev/null; then
    unused="$unused $k"
  fi
done
if [ -z "$unused" ]; then
  assert_ok "設定の項目はすべて入口の検証で使われている"
else
  assert_fail "決めたのに入口で使っていない項目がある" "$unused
      src/lib/validation/schemas.ts で使うか、設定から消す"
fi

echo "=== scenario 4: zod 側に数字が直接書かれていない ==="
if grep -q 'aidd.config.json' "$LIMITS_TS" 2>/dev/null; then
  assert_ok "上限は設定から読んでいる"
else
  assert_fail "上限が設定から読まれていない" "$LIMITS_TS"
fi
if grep -qE '\.max\([0-9]+' "$SCHEMAS" "$LIMITS_TS" 2>/dev/null; then
  assert_fail "上限の数字が直接書かれている" "$(grep -nE '\.max\([0-9]+' "$SCHEMAS" "$LIMITS_TS")"
else
  assert_ok "上限の数字が直接書かれていない"
fi

echo "=== scenario 5: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/config.json" <<'EOF'
{ "limits": { "textLength": { "a": 200, "b": 64 } } }
EOF
cat > "$WORK/mig.sql" <<'EOF'
ALTER TABLE t ADD CONSTRAINT c CHECK (length(x) <= 200 AND length(y) <= 999) NOT VALID;
EOF
CV=" $(config_values "$WORK/config.json") "
DV="$(migration_values "$WORK/mig.sql")"
orphan=""
for v in $DV; do
  case "$CV" in *" $v "*) ;; *) orphan="$orphan $v" ;; esac
done
if printf '%s' "$orphan" | grep -q '999'; then assert_ok "設定に無い上限値を検知"; else assert_fail "検知できない" "$orphan"; fi
if printf '%s' "$orphan" | grep -q '200'; then assert_fail "一致する値を違反にした" "$orphan"; else assert_ok "一致する値は誤検知しない"; fi

cat > "$WORK/bad-schema.ts" <<'EOF'
export const s = z.string().max(200)
EOF
if grep -qE '\.max\([0-9]+' "$WORK/bad-schema.ts"; then assert_ok "直書きの数字を検知"; else assert_fail "直書きを検知できない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
