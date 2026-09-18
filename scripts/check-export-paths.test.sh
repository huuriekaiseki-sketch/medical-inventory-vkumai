#!/bin/bash
# WHY: issue #757 の 17（CSV / エクスポート経路）。この製品には 2026-09-06 時点でエクスポート機能が
#      1 つも無いので、CSV injection（=+-@ で始まるセルが Excel で数式として実行される）や
#      「1 ファイルに他施設の行が混ざる」の検査は書けない。検査を「いつか書く」で終わらせないため、
#      **エクスポート経路が生えた瞬間に落ちる ratchet** にする。落ちたときにやることは
#      docs/agents/security-test-catalog.md「インポート／エクスポート境界」と
#      このスクリプトの EXPORT_CHECKLIST に書いてある。
#
#   (a) src/ に CSV / スプレッドシート / 添付ダウンロードの生成コードが無い
#       （text/csv・Content-Disposition・toCsv/toCSV・createObjectURL + download 属性）
#   (b) package.json にエクスポート系ライブラリが無い（papaparse / json2csv / xlsx / exceljs / file-saver）
#   (c) 許可リスト（ALLOWLIST）に載せた実装済み経路だけは (a)(b) を免除する。免除するには
#       security-test-catalog の該当行が「実装済み」で、守るテストのパスが書かれていること
#   (d) fixture で (a)(b) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-export-paths.test.sh
# 環境変数（テスト用注入ポイント）: EXPORT_SCAN_ROOT
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN_ROOT="${EXPORT_SCAN_ROOT:-$REPO_ROOT}"

# エクスポート経路を実装したらここにパスを足し、同時に下のチェックリストを満たすこと。
# 空 = 現在エクスポート機能は無い。
ALLOWLIST=""

EXPORT_CHECKLIST='このテストが落ちたら、エクスポート経路を足したということ。次を満たしてから ALLOWLIST に追記する:
      1. CSV injection: セルの先頭が = + - @ タブ CR のいずれかなら無害化する（先頭に単一引用符、または値をクォート）。
         患者イニシャル・手技名・メーカー名など自由入力の列が対象。守るテストを src/lib に置く
      2. 施設の混入: 出力に他施設の行が 1 件も無いことを実 DB の統合テストで固定する（RLS を通す経路で作り、
         service role で作らない）。P-017 の攻撃表にも route を足す
      3. PII: 出力に載せる列を明示列挙する（SELECT * を使わない）。patient_id を含むなら
         docs/agents/data-lifecycle-inventory.md に D-03x の行を足す（ダウンロード済みファイルは回収できない）
      4. docs/agents/security-test-catalog.md「インポート／エクスポート境界」を 実装済み にし、守るテストを書く'

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# (a) 生成コードの走査。$1=走査ルート
scan_source() {
  local root="$1"
  [ -d "$root/src" ] || return 0
  grep -rn \
    -e "text/csv" \
    -e "Content-Disposition" \
    -e "toCsv(" -e "toCSV(" \
    -e "createObjectURL(" \
    -e "download=" \
    "$root/src" 2>/dev/null || true
}

# (b) 依存の走査。$1=走査ルート
scan_deps() {
  local root="$1"
  [ -f "$root/package.json" ] || return 0
  grep -n -e '"papaparse"' -e '"json2csv"' -e '"xlsx"' -e '"exceljs"' -e '"file-saver"' -e '"csv-stringify"' \
    "$root/package.json" 2>/dev/null || true
}

# 許可リストに載っているパスの行を除く
drop_allowlisted() {
  local hits="$1" p
  [ -n "$ALLOWLIST" ] || { printf '%s' "$hits"; return; }
  for p in $ALLOWLIST; do
    hits="$(grep -v -F "$p" <<<"$hits" || true)"
  done
  printf '%s' "$hits"
}

echo "=== scenario 1: src/ にエクスポート生成コードが無い ==="
HITS="$(drop_allowlisted "$(scan_source "$SCAN_ROOT")")"
if [ -z "$HITS" ]; then
  assert_ok "エクスポート生成コードなし（許可リスト: ${ALLOWLIST:-なし}）"
else
  assert_fail "エクスポート経路が増えている" "$HITS
      $EXPORT_CHECKLIST"
fi

echo "=== scenario 2: エクスポート系の依存が無い ==="
DEPS="$(scan_deps "$SCAN_ROOT")"
if [ -z "$DEPS" ]; then
  assert_ok "エクスポート系ライブラリなし"
else
  assert_fail "エクスポート系ライブラリが入っている" "$DEPS
      $EXPORT_CHECKLIST"
fi

echo "=== scenario 3: 検査の引き出しに現状の判断が書いてある ==="
CATALOG="$REPO_ROOT/docs/agents/security-test-catalog.md"
ROW="$(grep '^| インポート／エクスポート境界 ' "$CATALOG" || true)"
if [ -z "$ROW" ]; then
  assert_fail "security-test-catalog に「インポート／エクスポート境界」の行が無い"
elif grep -q 'check-export-paths.test.sh' <<<"$ROW"; then
  assert_ok "引き出しの行がこの ratchet を指している"
else
  assert_fail "引き出しの行がこの ratchet を指していない（状態と引き金を書き換える）" "$ROW"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/app/api/export"
cat > "$WORK/src/app/api/export/route.ts" <<'EOF'
export async function GET() {
  return new Response('jan,name\n', {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders.csv"' },
  })
}
EOF
cat > "$WORK/package.json" <<'EOF'
{ "dependencies": { "papaparse": "^5.4.1" } }
EOF
SRC_HITS="$(scan_source "$WORK")"
DEP_HITS="$(scan_deps "$WORK")"
if grep -q 'text/csv' <<<"$SRC_HITS"; then assert_ok "CSV の生成を検知"; else assert_fail "CSV の生成を検知できない" "$SRC_HITS"; fi
if grep -q 'Content-Disposition' <<<"$SRC_HITS"; then assert_ok "添付ダウンロードを検知"; else assert_fail "添付ダウンロードを検知できない" "$SRC_HITS"; fi
if grep -q 'papaparse' <<<"$DEP_HITS"; then assert_ok "エクスポート系依存を検知"; else assert_fail "エクスポート系依存を検知できない" "$DEP_HITS"; fi

mkdir -p "$WORK/clean/src"
printf "export const x = 1\n" > "$WORK/clean/src/a.ts"
printf '{ "dependencies": { "next": "16.0.0" } }\n' > "$WORK/clean/package.json"
if [ -z "$(scan_source "$WORK/clean")$(scan_deps "$WORK/clean")" ]; then
  assert_ok "普通のコードは誤検知しない"
else
  assert_fail "普通のコードを誤検知した" "$(scan_source "$WORK/clean")$(scan_deps "$WORK/clean")"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
