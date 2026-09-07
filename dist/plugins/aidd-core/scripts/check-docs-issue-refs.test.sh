#!/bin/bash
# WHY: scripts/lib/check-docs-issue-refs.mjs（issue #714 残項目: 「保留・未対応」文脈で参照している issue が
#      CLOSED なら warning）の回帰テスト。gh を呼ばず --states で状態を注入する。
#      候補の抽出条件（同じ行に保留系マーカーがある参照だけ）・CLOSED だけ警告・OPEN/不明は警告しない・
#      フェンス内は無視・--strict の exit code を確認する。
#
# 実行: bash scripts/check-docs-issue-refs.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/lib/check-docs-issue-refs.mjs"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
contains() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }
not_contains() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ng "$3" "unexpected: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/docs/agents"
cat > "$WORK/docs/agents/x.md" <<'EOF'
# x

- 歴史: issue #10 で導入した（マーカー無し → 候補にしない）
- 保留: issue #11 の対応待ち（CLOSED → 警告）
- 保留: issue #12 は着手時期未定（OPEN → 警告しない）
- 未実装: issue #13 を待つ（状態不明 → 警告しない）
- 同じ行に2つ: issue #11 と issue #12 は検討中

```bash
# フェンス内: issue #11 は保留（無視）
```
EOF
cat > "$WORK/states.json" <<'EOF'
{ "11": "CLOSED", "12": "OPEN" }
EOF

echo "=== scenario 1: --list は保留系マーカーのある行の参照だけを候補にする ==="
OUT="$(node "$CHECKER" --root "$WORK" --files docs/agents/x.md --list)"
contains "$OUT" "candidates=5" "候補 5 件（#11×2, #12×2, #13）"
not_contains "$OUT" "issue #10" "マーカー無しの履歴参照は候補にしない"

echo "=== scenario 2: CLOSED だけ警告し、OPEN・不明は警告しない ==="
OUT="$(node "$CHECKER" --root "$WORK" --files docs/agents/x.md --states "$WORK/states.json")"
contains "$OUT" "warnings=2" "警告 2 件（#11 の 2 行）"
contains "$OUT" "issue #11" "CLOSED の #11 を警告"
not_contains "$OUT" "WARN: docs/agents/x.md:5" "OPEN の #12 だけの行は警告しない"
contains "$OUT" "unresolved=1" "状態不明 1 件（#13）を報告"

echo "=== scenario 3: 既定は warning-only（exit 0）、--strict なら exit 1 ==="
if node "$CHECKER" --root "$WORK" --files docs/agents/x.md --states "$WORK/states.json" >/dev/null; then ok "既定は exit 0"; else ng "既定で exit 非 0"; fi
if node "$CHECKER" --root "$WORK" --files docs/agents/x.md --states "$WORK/states.json" --strict >/dev/null; then ng "--strict で exit 0"; else ok "--strict で exit 1"; fi

echo "=== scenario 4: フェンス内の参照は無視する ==="
OUT="$(node "$CHECKER" --root "$WORK" --files docs/agents/x.md --list)"
not_contains "$OUT" "x.md:10" "フェンス内（10 行目）は候補にしない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
