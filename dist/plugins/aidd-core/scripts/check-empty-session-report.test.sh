#!/bin/bash
# WHY: scripts/check-empty-session-report.sh(SessionStart hook、issue #673)の回帰テスト。
# 実物のリポジトリのdocs/sessions/を汚さず、EMPTY_SESSION_REPORT_PROJECT_DIRで
# フェイクのgitリポジトリを指すよう差し替えて決定的に検証する
# （check-local-main-freshness.test.shと同型）。
#
# 実行: bash scripts/check-empty-session-report.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-empty-session-report.sh"

fail=0
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

REPO="$WORKDIR/fake-repo"
mkdir -p "$REPO/docs/sessions"
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "test"
echo "init" > "$REPO/README.md"
echo "placeholder" > "$REPO/docs/sessions/.gitkeep"
git -C "$REPO" add README.md docs/sessions/.gitkeep
git -C "$REPO" commit -q -m "init"

run_hook() {
  set +e
  OUT="$(EMPTY_SESSION_REPORT_PROJECT_DIR="$REPO" bash "$SCRIPT" < /dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: docs/sessions/が空 → 何も出力しない ==="
run_hook
assert_empty "$OUT" "セッションレポートが無ければ沈黙する"

echo "=== scenario 2: 結果欄が全空の未コミットファイル → 警告する ==="
cat > "$REPO/docs/sessions/2099-01-01-empty.md" <<'EOF'
# 2099-01-01 empty

## 結果
- うまくいったこと:
- 問題・気になった点:
- 次の課題:
EOF
run_hook
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "2099-01-01-empty.md" "空テンプレのファイル名が含まれる"
rm -f "$REPO/docs/sessions/2099-01-01-empty.md"

echo "=== scenario 3: 結果欄が記入済みの未コミットファイル → 警告しない ==="
cat > "$REPO/docs/sessions/2099-01-01-filled.md" <<'EOF'
# 2099-01-01 filled

## 結果
- うまくいったこと: 動いた
- 問題・気になった点: 特になし
- 次の課題: なし
EOF
run_hook
assert_empty "$OUT" "記入済みファイルは警告されない"
rm -f "$REPO/docs/sessions/2099-01-01-filled.md"

echo "=== scenario 4: 空テンプレがコミット済み → 警告しない(対象外) ==="
cat > "$REPO/docs/sessions/2099-01-01-committed-empty.md" <<'EOF'
# 2099-01-01 committed-empty

## 結果
- うまくいったこと:
- 問題・気になった点:
- 次の課題:
EOF
git -C "$REPO" add docs/sessions/2099-01-01-committed-empty.md
git -C "$REPO" commit -q -m "add committed empty template"
run_hook
assert_empty "$OUT" "コミット済みの空テンプレは検知対象外"

echo "=== scenario 5: 一部項目だけ記入済み → 3項目全空ではないので警告しない ==="
cat > "$REPO/docs/sessions/2099-01-02-partial.md" <<'EOF'
# 2099-01-02 partial

## 結果
- うまくいったこと: 一部だけ書いた
- 問題・気になった点:
- 次の課題:
EOF
run_hook
assert_empty "$OUT" "1項目でも記入済みなら未記入テンプレ扱いにしない(偽陽性回避)"
rm -f "$REPO/docs/sessions/2099-01-02-partial.md"

echo "=== scenario 6: docs/sessionsディレクトリ自体が無い → クラッシュせず沈黙する ==="
NO_SESSIONS_REPO="$WORKDIR/no-sessions-repo"
mkdir -p "$NO_SESSIONS_REPO"
git -C "$NO_SESSIONS_REPO" init -q
git -C "$NO_SESSIONS_REPO" config user.email "test@example.com"
git -C "$NO_SESSIONS_REPO" config user.name "test"
echo "init" > "$NO_SESSIONS_REPO/README.md"
git -C "$NO_SESSIONS_REPO" add README.md
git -C "$NO_SESSIONS_REPO" commit -q -m "init"
set +e
OUT="$(EMPTY_SESSION_REPORT_PROJECT_DIR="$NO_SESSIONS_REPO" bash "$SCRIPT" < /dev/null)"
EXIT_CODE=$?
set -e
assert_empty "$OUT" "docs/sessions/不在でもクラッシュしない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
