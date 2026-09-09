#!/usr/bin/env bash
# WHY: issue #757 の 20。2026-09-07 に見つけた実害 8 件のうち **6 件が層の間の食い違い**だった。
#        - API が DB より緩い（数量 0 を通す。DB は I-010 で 1 以上）
#        - API が DB より厳しい（互換の備考が API 500・DB 1,000）
#        - 型（ロジック層）の必須項目を API が見ていない（代理店商品の入数・償還価格）
#        - 設定に無い値が DB にある（医師名・使用期限・仕入先）
#      どれも**作る段階で 4 層（UI / API / ロジック / DB）を突き合わせていれば起きなかった**。
#
# 2026-09-07 の改訂（Codex の指摘「対応表を手で書くこと自体がズレの発生源になる」）:
#   両側とも**実物から自動抽出**する。
#     DB 側 … scripts/lib/scan-db-constraints.mjs（migration を畳み込む）
#     API 側 … scripts/lib/extract-api-rules.ts（zod スキーマを実行時に内省する）
#   対応付けは**命名規約から自動で導く**（列名 snake_case → フィールド名 camelCase）。
#   人が書くのは scripts/lib/layer-map.json の 2 つだけ:
#     tables … 表 → スキーマ名（規約で導けない対応のみ）
#     columns … 規約から外れる列・利用者が送れない列（serverOnly）・期限付きの例外
#   **値そのものを比べる**（種類が合っているかではなく、200 と 200 が一致するか）。
#
#   (a) DB の CHECK がある列は、規約か対応表のどちらかで API 側に紐づく
#   (b) 紐づいた先の**値が一致する**（maxLength / min / enum）
#   (c) 例外（exception）には理由と期限が要り、期限を過ぎたら落ちる
#   (d) 対応表が陳腐化していない（DB に無い列・API に無いフィールドを指していない）
#   (e) 走査で条件が取れなければ落とす（fail-open 防止）
#   (f) fixture で検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-layer-consistency.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_SCANNER="$REPO_ROOT/scripts/lib/scan-db-constraints.mjs"
API_EXTRACTOR="$REPO_ROOT/scripts/lib/extract-api-rules.ts"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
MAP="$REPO_ROOT/scripts/lib/layer-map.json"
COMPARER="$REPO_ROOT/scripts/lib/compare-layers.mjs"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# API 側は zod を実行時に内省するので TypeScript を実行する必要がある。
# WHY(npx -y tsx を使わない): 毎回レジストリから落としてくる（2026-09-04 に CI が 4〜8 倍に
#      なった原因。scripts/check-no-registry-fetch.test.sh が hook スクリプトで禁止している）。
#      node_modules に既にある vitest で実行する。
API_JSON="$(mktemp)"
trap 'rm -f "$API_JSON"' EXIT
# WHY(対象ファイルをフラグより**前**に置く、2026-09-09 実測): `--disable-console-intercept` は
#      この版の vitest では**値を取るフラグとして解釈され、次の位置引数を飲み込む**。
#      そのせいでこの 1 行は長らく**単体テスト 236 ファイル全部**を回していた
#      （1 つの JSON を出すためだけに 20 秒。機械が混んでいると worker の起動が間に合わず落ちる）。
#      実測: フラグ → ファイルの順で 229 ファイル、ファイル → フラグの順で 1 ファイル。
#      **綴りを直す（`--disableConsoleIntercept`）でも 1 ファイルになる**が、
#      並び順のほうが版に依らないのでこちらにする。
EMIT_LOG="$(mktemp)"
trap 'rm -f "$API_JSON" "$EMIT_LOG"' EXIT
if ! ./node_modules/.bin/vitest run --config vitest.config.ts \
     scripts/lib/__tests__/extract-api-rules.emit.test.ts \
     --reporter=dot --disableConsoleIntercept > "$EMIT_LOG" 2>&1; then
  echo "  NG: API 側のスキーマを読み取れない（scripts/lib/__tests__/extract-api-rules.emit.test.ts）"
  tail -20 "$EMIT_LOG"
  exit 1
fi
# WHY(件数まで見る、2026-09-09): 「通った」だけでは**全部回してしまったこと**に気づけない。
#      並びを戻されたら 236 ファイル回る形へ黙って戻るので、**1 ファイルであること**を毎回測る。
#      これ自体が C-031（数える単位）と C-022（戻ったら落ちるか）の対。
if ! grep -qE 'Test Files +1 passed \(1\)' "$EMIT_LOG"; then
  echo "  NG: 抽出のための実行が 1 ファイルに絞れていない（位置引数がフラグに飲まれている疑い）"
  grep -E 'Test Files' "$EMIT_LOG"
  exit 1
fi
cp "$REPO_ROOT/.api-rules.json" "$API_JSON" 2>/dev/null || {
  echo "  NG: API 側の抽出結果が出力されていない"
  exit 1
}
rm -f "$REPO_ROOT/.api-rules.json"

echo "=== scenario 1: 両側から条件を取れている（fail-open 防止） ==="
DB_COUNT="$(node "$DB_SCANNER" "$MIGRATIONS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).length))')"
API_COUNT="$(node -e 'const fs=require("fs");console.log(Object.keys(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))).length)' "$API_JSON")"
if [ "${DB_COUNT:-0}" -lt 20 ]; then
  assert_fail "DB の CHECK が少なすぎる（$DB_COUNT 列）。走査が壊れている疑い"
elif [ "${API_COUNT:-0}" -lt 20 ]; then
  assert_fail "API の規則が少なすぎる（$API_COUNT 件）。抽出が壊れている疑い"
else
  assert_ok "DB $DB_COUNT 列 / API $API_COUNT 件を突き合わせる"
fi

echo "=== scenario 2: 実態に食い違いが無い ==="
OUT="$(node "$COMPARER" "$MIGRATIONS" "$API_JSON" "$MAP" 2>&1)"
if [ -z "$OUT" ]; then
  assert_ok "DB と API の条件が値まで一致している"
else
  assert_fail "層の間に食い違いがある" "$OUT"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "$API_JSON"' EXIT
mkdir -p "$WORK/migrations"
cat > "$WORK/migrations/0001.sql" <<'SQL'
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  looser TEXT NOT NULL,
  hidden TEXT NOT NULL,
  forgotten TEXT NOT NULL
);
ALTER TABLE notes ADD CONSTRAINT c1 CHECK (length(body) <= 100) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c2 CHECK (kind IN ('a', 'b')) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c3 CHECK (amount >= 1) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c4 CHECK (length(looser) <= 50) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c5 CHECK (length(hidden) <= 50) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c6 CHECK (length(forgotten) <= 50) NOT VALID;
SQL
cat > "$WORK/api.json" <<'JSON'
{
  "noteSchema.body": { "type": "string", "maxLength": 100, "min": null, "enum": null },
  "noteSchema.kind": { "type": "enum", "maxLength": null, "min": null, "enum": ["a"] },
  "noteSchema.looser": { "type": "string", "maxLength": 999, "min": null, "enum": null }
}
JSON
cat > "$WORK/map.json" <<'JSON'
{
  "tables": { "notes": "noteSchema" },
  "columns": {
    "notes.hidden": { "serverOnly": "サーバーが入れる" },
    "notes.gone": { "serverOnly": "もう無い列" }
  }
}
JSON
FOUT="$(node "$COMPARER" "$WORK/migrations" "$WORK/api.json" "$WORK/map.json" 2>&1)"
check() { if printf '%s' "$FOUT" | grep -q "$1"; then assert_ok "$2"; else assert_fail "$2" "$FOUT"; fi; }
check 'notes.amount' '規約で導いた先が API に無いことを検知'
check 'notes.looser' '値の食い違い（DB 50 / API 999）を検知'
check 'notes.kind' '固定語の食い違い（DB 2 語 / API 1 語）を検知'
check 'notes.forgotten' '分類も規約も無い列を検知'
check 'notes.gone' '陳腐化した行を検知'
if printf '%s' "$FOUT" | grep -q 'notes.hidden'; then assert_fail "serverOnly を違反にした" "$FOUT"; else assert_ok "serverOnly は誤検知しない"; fi
if printf '%s' "$FOUT" | grep -q 'notes.body'; then assert_fail "一致している列を違反にした" "$FOUT"; else assert_ok "一致は誤検知しない"; fi

echo "=== scenario 4: 期限切れの例外を検知する ==="
cat > "$WORK/map-expired.json" <<'JSON'
{
  "tables": { "notes": "noteSchema" },
  "columns": {
    "notes.amount": { "exception": "移行待ち", "until": "2000-01-01" },
    "notes.kind": { "exception": "まだ揃えていない", "until": "2999-01-01" },
    "notes.looser": { "serverOnly": "対象外" },
    "notes.hidden": { "serverOnly": "サーバーが入れる" },
    "notes.forgotten": { "serverOnly": "サーバーが入れる" }
  }
}
JSON
EOUT="$(node "$COMPARER" "$WORK/migrations" "$WORK/api.json" "$WORK/map-expired.json" 2>&1)"
if printf '%s' "$EOUT" | grep -q 'expired.*notes.amount'; then assert_ok "期限切れの例外を検知"; else assert_fail "期限切れを検知できない" "$EOUT"; fi
if printf '%s' "$EOUT" | grep -q 'notes.kind'; then assert_fail "期限内の例外を違反にした" "$EOUT"; else assert_ok "期限内の例外は通す"; fi

cat > "$WORK/map-noreason.json" <<'JSON'
{
  "tables": { "notes": "noteSchema" },
  "columns": {
    "notes.amount": { "exception": "理由はあるが期限が無い" },
    "notes.kind": { "serverOnly": "対象外" },
    "notes.looser": { "serverOnly": "対象外" },
    "notes.hidden": { "serverOnly": "対象外" },
    "notes.forgotten": { "serverOnly": "対象外" }
  }
}
JSON
NOUT="$(node "$COMPARER" "$WORK/migrations" "$WORK/api.json" "$WORK/map-noreason.json" 2>&1)"
if printf '%s' "$NOUT" | grep -q 'no-expiry.*notes.amount'; then assert_ok "期限の無い例外を検知"; else assert_fail "期限なしを検知できない" "$NOUT"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
