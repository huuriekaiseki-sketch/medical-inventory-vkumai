#!/bin/bash
# WHY: `.gitattributes` の merge=union は衝突を報告せず、同じ行を両側が別々に書き換えると
# **両方の行が並んで残る**。ID 列のあるルールブックは check-catalog.mjs の ID 重複検査が落とすが、
# ID 列を持たない棚卸し表には検知が無く、2026-09-07 に実際に 10 行の重複が残っていた
# （security-test-catalog 7 組・actuator-inventory 2 組・test-matrix 1 組。どれも
# 「計画のまま・根拠列が空」の古い版と「実装済み＋根拠つき」の新しい版の組で、
# 古い版を読むと「まだやっていない」と誤読する）。
#
# 検査本体は scripts/lib/check-table-row-duplicates.mjs。ここはその構造テスト。
#
# 実行: bash scripts/check-table-row-duplicates.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を導入先だと思い込む（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
CHECKER="$SCRIPT_DIR/lib/check-table-row-duplicates.mjs"

# 対象の表の登録簿は導入先のもの（エンジンは共通側）。無ければ見るものが無い
if [ ! -f "$REPO_ROOT/scripts/lib/table-duplicates-registry.json" ]; then
  echo "=== scenario 0: この導入先には対象の表の登録簿が無い ==="
  echo "  SKIP: scripts/lib/table-duplicates-registry.json が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== scenario 1: 検査スクリプトが存在し実行できる ==="
if [ -f "$CHECKER" ]; then
  assert_ok "存在する: scripts/lib/check-table-row-duplicates.mjs"
else
  assert_fail "存在しない: $CHECKER"
fi

echo "=== scenario 2: 実態のリポジトリに重複が無い ==="
if out="$(cd "$REPO_ROOT" && node "$CHECKER" 2>&1)"; then
  assert_ok "違反なし（${out}）"
else
  assert_fail "実態に重複がある" "$out"
fi

echo "=== scenario 3: 対象ファイルが .gitattributes の union 対象と食い違わない ==="
# 検査対象に挙げたファイルは、union merge が効いているからこそ守る必要がある。
# union を外したのに検査対象に残っている／union なのに検査対象から漏れている、を防ぐ。
listed="$(cd "$REPO_ROOT" && node -e '
import("./scripts/lib/check-table-row-duplicates.mjs").then((m) => {
  for (const t of m.loadTables(process.cwd())) console.log(t.file)
})' | sort)"
for f in $listed; do
  if grep -q "^${f//\//\\/}[[:space:]]\+merge=union" "$REPO_ROOT/.gitattributes"; then
    assert_ok "union 対象で検査もされる: $f"
  else
    assert_fail "検査対象だが .gitattributes の merge=union ではない: $f" \
      "union を外したならこの表を TABLES から消すか、外した理由をコメントに書く"
  fi
done

echo "=== scenario 4: fixture で重複を検知できる（RED 方向の自己検証） ==="
mkdir -p "$TMP/docs/agents"
# WHY(登録簿も置く、2026-09-09): 対象の表は登録簿（scripts/lib/table-duplicates-registry.json）から取る。
#      置かないと対象 0 件で通ってしまい、**fixture が何も測らない**（実際にそうなった）
mkdir -p "$TMP/scripts/lib"
cp "$REPO_ROOT/scripts/lib/table-duplicates-registry.json" "$TMP/scripts/lib/"
cat > "$TMP/docs/agents/security-test-catalog.md" <<'MD'
| 観点 | 何を確かめるか | 状態 | 引き金 |
|---|---|---|---|
| 部分成功 | 中間状態 | 計画 | |
| 別の観点 | 何か | 実装済み | 根拠 |
| 部分成功 | 中間状態 | 実装済み | 根拠つき |
MD
# 他の 4 ファイルは重複なしの最小形で用意する（検査は全ファイルを読むため）。
# actuator-inventory は鍵が 2 列目なので、1 列目だけでなく 2 列目も一意にしておく
for f in test-matrix actuator-inventory portability-inventory undetectable-rules-inventory; do
  cat > "$TMP/docs/agents/$f.md" <<'MD'
| A | B | C | D |
|---|---|---|---|
| 一意1 | b1 | y | z |
| 一意2 | b2 | y | z |
MD
done

if out="$(cd "$TMP" && node "$CHECKER" . 2>&1)"; then
  assert_fail "重複があるのに通ってしまった" "$out"
else
  assert_ok "重複を検知して終了コード 1"
  if echo "$out" | grep -q '部分成功'; then
    assert_ok "重複した鍵を名指しする"
  else
    assert_fail "鍵を名指ししていない" "$out"
  fi
  if echo "$out" | grep -qE '3 行と 5 行'; then
    assert_ok "重複した行番号の両方を出す"
  else
    assert_fail "行番号が出ていない" "$out"
  fi
fi

echo "=== scenario 5: 見出し行は重複として数えない ==="
# 表が 2 つある文書で、両方の見出しが同じ語でも違反にしない
cat > "$TMP/docs/agents/security-test-catalog.md" <<'MD'
| 観点 | 何を確かめるか |
|---|---|
| ひとつめ | x |

## 別の節

| 観点 | 何を確かめるか |
|---|---|
| ふたつめ | y |
MD
if out="$(cd "$TMP" && node "$CHECKER" . 2>&1)"; then
  assert_ok "同じ見出しの表が 2 つあっても違反にしない"
else
  assert_fail "見出し行を重複と誤検知した" "$out"
fi

echo "=== scenario 6: 鍵の列を指定できる（1 列目が重複しても 2 列目が一意なら通る） ==="
# actuator-inventory は 1 列目が hook イベント名で重複が正常。鍵は 2 列目（スクリプト）
cat > "$TMP/docs/agents/actuator-inventory.md" <<'MD'
| イベント | スクリプト | 是正 | 説明 |
|---|---|---|---|
| SessionStart | `a.sh` | warning | x |
| SessionStart | `b.sh` | warning | y |
MD
cat > "$TMP/docs/agents/security-test-catalog.md" <<'MD'
| 観点 | 何を確かめるか |
|---|---|
| ひとつ | x |
MD
if out="$(cd "$TMP" && node "$CHECKER" . 2>&1)"; then
  assert_ok "1 列目の重複は許し、2 列目で判定する"
else
  assert_fail "鍵の列の指定が効いていない" "$out"
fi

# 2 列目が重複したら落ちること（上の裏返し）
cat > "$TMP/docs/agents/actuator-inventory.md" <<'MD'
| イベント | スクリプト | 是正 | 説明 |
|---|---|---|---|
| SessionStart | `a.sh` | warning | 新しい説明 |
| Stop | `a.sh` | warning | 古い説明 |
MD
if (cd "$TMP" && node "$CHECKER" . >/dev/null 2>&1); then
  assert_fail "2 列目が重複しているのに通ってしまった"
else
  assert_ok "2 列目の重複は検知する"
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "FAILED"
  exit 1
fi
