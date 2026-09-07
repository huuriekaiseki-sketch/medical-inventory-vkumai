#!/usr/bin/env bash
# WHY: ルールブック（カタログ）の形を、1 本のエンジンで全件検査する。
#      これまでは新しいルールブックを足すたびに 150 行の bash を書き写しており、写すたびに
#      検査の中身が少しずつ違っていた（重複 ID を見ない・パスの実在を見ない等）。
#      エンジン（scripts/lib/check-catalog.mjs）と登録簿（scripts/lib/catalog-registry.json）に分け、
#      新しいルールブックは登録簿の 1 エントリと文書だけで検査対象に入る。
#
#   (a) 登録簿の全ルールブックに違反が無い
#   (b) 登録簿のエントリが指す文書が実在する
#   (c) fixture でエンジンが各違反（列数・ID の形・重複・帯・状態の語彙・計画番号・
#       守るテスト無し・パス不在）を検知できる（RED 方向の自己検証）
#   (d) 正しい fixture は 1 件も誤検知しない
#   (e) 索引（docs/agents/rulebooks.md）が登録簿から作り直した内容と一致する
#
# 実行: bash scripts/check-catalogs.test.sh
# 環境変数（テスト用注入ポイント）: CATALOG_REGISTRY
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/check-catalog.mjs"
REGISTRY="${CATALOG_REGISTRY:-$SCRIPT_DIR/lib/catalog-registry.json}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

echo "=== scenario 1: 登録簿の全ルールブックに違反が無い ==="
OUT="$(node "$ENGINE" "$REGISTRY" --root "$REPO_ROOT")"
LAST="$(printf '%s\n' "$OUT" | tail -n1)"
COUNT="$(node -e '
const fs = require("fs")
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
console.log((r.catalogs ?? []).length)
' "$REGISTRY")"
if [ "$LAST" = "violations=0" ]; then
  assert_ok "違反なし（ルールブック ${COUNT} 件）"
else
  assert_fail "違反あり" "$OUT"
fi

echo "=== scenario 2: 登録簿の文書が実在する ==="
MISSING="$(node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[2]
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const c of r.catalogs ?? []) {
  if (!fs.existsSync(path.join(root, c.file))) console.log(c.id + ": " + c.file)
}
' "$REGISTRY" "$REPO_ROOT")"
if [ -z "$MISSING" ]; then assert_ok "全て実在する"; else assert_fail "登録簿が指す文書が無い" "$MISSING"; fi

echo "=== scenario 3: fixture で各違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SPEC='{"id":"fixture","idPrefix":"Z","columns":4,"evidenceColumn":3,"statusColumn":4,"states":["済み","計画","対象外"],"evidenceRequiredStates":["済み"],"planRequiredStates":["計画"],"planPattern":"#[0-9]+-[0-9]+","idBands":[0,10]}'

cat > "$WORK/bad.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 正常 | `package.json` | 済み |
| Z-002 | 正常（計画に番号あり） | 未 | 計画（#757-99） |
| Z-003 | 計画に番号なし | 未 | 計画 |
| Z-004 | 済みなのに守るテストなし | 未 | 済み |
| Z-005 | 状態が語彙にない | 未 | たぶん済み |
| Z-006 | 不在パス | `scripts/no-such.sh` | 済み |
| Z-99 | 桁不足 | `package.json` | 済み |
| Z-001 | 重複 | `package.json` | 済み |
| Z-030 | 帯の外 | `package.json` | 済み |
| Z-007 | 列ずれ | 済み |
EOF

OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/bad.md" --root "$REPO_ROOT")"
for needle in \
  'plan: \[Z-003\]' \
  'evidence: \[Z-004\]' \
  'status: \[Z-005\]' \
  'path: \[Z-006\]' \
  'id: \[Z-99\]' \
  'id: \[Z-001\] ID が重複' \
  'band: \[Z-030\]' \
  'columns: \[Z-007\]' \
; do
  if printf '%s\n' "$OUT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle" "$OUT"; fi
done
if printf '%s\n' "$OUT" | grep -q 'Z-002'; then
  assert_fail "計画番号がある行を誤検知" "$OUT"
else
  assert_ok "計画番号がある行は誤検知しない"
fi

echo "=== scenario 4: 正しい fixture は 1 件も出さない ==="
cat > "$WORK/good.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 正常 | `package.json` | 済み |
| Z-010 | 別の帯 | 未 | 計画（#757-99） |
| Z-011 | 対象外 | 未 | 対象外 |
EOF
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/good.md" --root "$REPO_ROOT")"
if [ "$(printf '%s\n' "$OUT" | tail -n1)" = "violations=0" ]; then
  assert_ok "誤検知なし"
else
  assert_fail "正しい fixture を違反にした" "$OUT"
fi

echo "=== scenario 5: 行が 1 つも無いルールブックは違反にする（空の登録を許さない） ==="
printf '| ID | 内容 |\n| --- | --- |\n' > "$WORK/empty.md"
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/empty.md" --root "$REPO_ROOT")"
if printf '%s\n' "$OUT" | grep -q '行が 1 つも無い'; then
  assert_ok "空のルールブックを検知"
else
  assert_fail "空を検知できない" "$OUT"
fi

echo "=== scenario 6: 索引が最新（登録簿から生成し直した内容と一致する） ==="
if OUT="$(bash "$SCRIPT_DIR/render-rulebook-index.sh" --check 2>&1)"; then
  assert_ok "索引は最新"
else
  assert_fail "索引が古い（bash scripts/render-rulebook-index.sh で作り直す）" "$OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
