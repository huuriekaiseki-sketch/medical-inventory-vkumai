#!/bin/bash
# WHY: scripts/lib/check-docs-integrity.mjs（docs/agents 等の知識庫のリンク切れ・アンカー不一致・
#      削除済みパス言及の機械検知、issue #714）の回帰テスト。実態の docs に違反が無いこと（GREEN）と、
#      fixture で 3 種の違反をちょうど検知しつつ、歴史的マーカー付き・プレースホルダ・git ignore 対象は
#      誤検知しないこと（RED 方向の自己検証）を確認する。
#
# 実行: bash scripts/check-docs-integrity.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKER="$SCRIPT_DIR/lib/check-docs-integrity.mjs"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if printf '%s\n' "$1" | grep -qF -- "$2"; then assert_ok "$3"; else assert_fail "$3" "expected: $2"; fi
}
assert_not_contains() {
  if printf '%s\n' "$1" | grep -qF -- "$2"; then assert_fail "$3" "unexpected: $2"; else assert_ok "$3"; fi
}

echo "=== scenario 1: 実態の docs に違反が無い ==="
if OUT="$(node "$CHECKER" 2>&1)"; then
  assert_ok "違反なし（$(printf '%s\n' "$OUT" | tail -n1)）"
else
  assert_fail "違反あり" "$OUT"
fi

echo "=== scenario 2: fixture で違反をちょうど検知する（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/docs/agents" "$WORK/scripts"
git -C "$WORK" init -q
printf 'ignored.local\n' > "$WORK/.gitignore"
printf '#!/bin/bash\n' > "$WORK/scripts/exists.sh"
cat > "$WORK/docs/agents/target.md" <<'EOF'
# 目次

## なぜ RLS / facility 境界に限定したか（PR③、2026-09-04）

本文。
EOF
cat > "$WORK/docs/agents/source.md" <<'EOF'
# ソース

- 正常: [target](./target.md) / [anchor ok](./target.md#なぜ-rls--facility-境界に限定したかpr2026-09-04) / [self](#ソース)
- リンク切れ: [missing](./missing.md)
- アンカー不一致: [bad anchor](./target.md#存在しない見出し)
- 実在パス: `scripts/exists.sh`
- 不在パス: `scripts/gone.sh`
- 歴史的マーカー付き: `scripts/old.sh`（削除済み、PR #1）
- プレースホルダ: `scripts/...` と `scripts/<name>.sh`
- git ignore 対象: `scripts/ignored.local`
- 外部: [ext](https://example.com/x#y)

```bash
# フェンス内は無視: [x](./nope.md) `scripts/nope.sh`
```
EOF
set +e
OUT="$(node "$CHECKER" --root "$WORK" --files docs/agents/source.md 2>&1)"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then assert_ok "違反ありで exit 1"; else assert_fail "違反があるのに exit 0" "$OUT"; fi
assert_contains "$OUT" "violations=3" "違反 3 件をちょうど検知"
assert_contains "$OUT" "[link] リンク先が存在しない: ./missing.md" "検知: リンク切れ"
assert_contains "$OUT" "[anchor] アンカーに一致する見出しが無い" "検知: アンカー不一致"
assert_contains "$OUT" "[path] 言及されたパスが存在しない: \`scripts/gone.sh\`" "検知: 不在パス"
assert_not_contains "$OUT" "scripts/old.sh" "歴史的マーカー付きは誤検知しない"
assert_not_contains "$OUT" "scripts/..." "プレースホルダは誤検知しない"
assert_not_contains "$OUT" "scripts/<name>.sh" "山括弧プレースホルダは誤検知しない"
assert_not_contains "$OUT" "scripts/ignored.local" "git ignore 対象は誤検知しない"
assert_not_contains "$OUT" "nope" "フェンス内は誤検知しない"
assert_not_contains "$OUT" "example.com" "外部 URL は検査しない"

echo "=== scenario 3: 走査対象が存在しなければ違反として扱う（fail-open 防止） ==="
set +e
OUT="$(node "$CHECKER" --root "$WORK" --files docs/agents/absent.md 2>&1)"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then assert_ok "対象不在で exit 1"; else assert_fail "対象不在なのに exit 0" "$OUT"; fi
assert_contains "$OUT" "[missing]" "検知: 走査対象ファイル不在"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
