#!/bin/bash
# WHY: package-lock.json は「どの版をどこから取るか」まで固定した発注書だが、発注書そのものに
#      レジストリ外（git / http / file）の出所や整合性ハッシュ無しの項目が混ざると、npm ci でも
#      毎回同じ部品が入る保証が崩れる。全項目が registry.npmjs.org 由来で sha512 の integrity を
#      持つこと、package.json の依存指定にレジストリ外の書き方が無いことを CI（hooks-test）で
#      毎 PR 固定する（docs/agents/known-failure-patterns.md「依存関係層」、2026-09-04）。
#
# 見つけられること: 出所がレジストリ外の項目、integrity 欠落、package.json の git:/file:/http 指定
# 見つけられないこと: レジストリ上の正規パッケージ内部の悪意（それは依存差分レビュー・npm audit の役割）
#
# 実行: bash scripts/check-lockfile-integrity.test.sh
# 環境変数（テスト用注入ポイント）:
#   LOCKFILE_PATH        検査するロック（既定 package-lock.json）
#   PACKAGE_JSON_PATH    検査する package.json（既定 package.json）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK="${LOCKFILE_PATH:-$REPO_ROOT/package-lock.json}"
PKG="${PACKAGE_JSON_PATH:-$REPO_ROOT/package.json}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# 検査本体。$1=lock $2=package.json。違反行を出し、末尾に violations=N
check() {
  local lock="$1" pkg="$2" violations=0 hits n

  # 1. lock の全 resolved が registry.npmjs.org 由来（link・bundled は resolved を持たないので対象外）
  hits="$(jq -r '.packages | to_entries[] | select(.value.resolved != null) | select(.value.resolved | startswith("https://registry.npmjs.org/") | not) | "\(.key) -> \(.value.resolved)"' "$lock")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's/^/    resolved: /'
    violations=$((violations + $(printf '%s\n' "$hits" | grep -c .)))
  fi

  # 2. resolved を持つ項目は sha512 の integrity を持つ
  hits="$(jq -r '.packages | to_entries[] | select(.value.resolved != null) | select((.value.integrity // "") | startswith("sha512-") | not) | .key' "$lock")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's/^/    integrity: /'
    violations=$((violations + $(printf '%s\n' "$hits" | grep -c .)))
  fi

  # 3. package.json の dependencies / devDependencies / optionalDependencies にレジストリ外の指定が無い
  hits="$(jq -r '[.dependencies, .devDependencies, .optionalDependencies] | map(select(. != null)) | add // {} | to_entries[] | select(.value | test("^(git\\+|git:|github:|gitlab:|bitbucket:|file:|link:|https?://|[a-z0-9-]+/[a-z0-9-]+$)")) | "\(.key): \(.value)"' "$pkg")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's/^/    spec: /'
    violations=$((violations + $(printf '%s\n' "$hits" | grep -c .)))
  fi

  # 4. lock の項目数が 0 でない（パーサ自壊の検知）
  n="$(jq -r '.packages | length' "$lock")"
  if [ "${n:-0}" -lt 2 ]; then
    echo "    empty: lock の packages が $n 件（パース失敗か空ファイル）"
    violations=$((violations+1))
  fi

  echo "violations=$violations"
}

echo "=== scenario 1: 実態の package-lock.json / package.json に違反が無い ==="
RESULT="$(check "$LOCK" "$PKG")"
printf '%s\n' "$RESULT" | grep -v '^violations=' || true
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし（$(jq -r '.packages | length' "$LOCK") 項目）"
else
  assert_fail "違反あり" "$(printf '%s\n' "$RESULT" | tail -n1)"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cat > "$WORK_DIR/lock.json" <<'EOF'
{
  "name": "fixture", "lockfileVersion": 3,
  "packages": {
    "": { "name": "fixture" },
    "node_modules/good": { "version": "1.0.0", "resolved": "https://registry.npmjs.org/good/-/good-1.0.0.tgz", "integrity": "sha512-abc" },
    "node_modules/evil-mirror": { "version": "1.0.0", "resolved": "https://evil.example/evil-1.0.0.tgz", "integrity": "sha512-abc" },
    "node_modules/from-git": { "version": "1.0.0", "resolved": "git+ssh://git@github.com/x/y.git#deadbeef" },
    "node_modules/no-integrity": { "version": "1.0.0", "resolved": "https://registry.npmjs.org/no-integrity/-/no-integrity-1.0.0.tgz" },
    "node_modules/sha1-only": { "version": "1.0.0", "resolved": "https://registry.npmjs.org/sha1-only/-/sha1-only-1.0.0.tgz", "integrity": "sha1-abc" },
    "node_modules/linked": { "resolved": "../linked", "link": true }
  }
}
EOF
cat > "$WORK_DIR/package.json" <<'EOF'
{
  "dependencies": { "good": "^1.0.0", "from-github": "github:x/y", "shorthand": "x/y", "local": "file:../local" },
  "devDependencies": { "from-url": "https://example.com/pkg.tgz" }
}
EOF
RESULT="$(check "$WORK_DIR/lock.json" "$WORK_DIR/package.json")"
# 期待: resolved 3（evil-mirror・from-git・linked の ../linked）+ integrity 4（from-git・no-integrity・sha1-only・linked）
#       + spec 4（github:・x/y・file:・https）= 11
EXPECTED=11
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in 'resolved: node_modules/evil-mirror' 'resolved: node_modules/from-git' 'integrity: node_modules/no-integrity' 'integrity: node_modules/sha1-only' 'spec: from-github' 'spec: shorthand' 'spec: local' 'spec: from-url'; do
  if printf '%s\n' "$RESULT" | grep -qF "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'node_modules/good'; then assert_fail "正常項目 good を誤検知"; else assert_ok "正常項目 good は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
