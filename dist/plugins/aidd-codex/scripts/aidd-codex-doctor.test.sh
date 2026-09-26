#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; fail=1; }

PLUGIN="$WORK/plugin"
REPO="$WORK/consumer"
mkdir -p "$PLUGIN/scripts" "$PLUGIN/hooks" "$REPO/.codex"
cp "$SCRIPT_DIR/aidd-codex-doctor.sh" "$PLUGIN/scripts/"
cat > "$PLUGIN/hooks/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"command":"\"${PLUGIN_ROOT}\"/scripts/check-branch-pr-status.sh"},{"command":"\"${PLUGIN_ROOT}\"/scripts/check-branch-tool-ownership.sh codex"},{"command":"\"${PLUGIN_ROOT}\"/scripts/check-local-main-freshness.sh"}]}],"PreToolUse":[{"hooks":[{"command":"\"${PLUGIN_ROOT}\"/scripts/codex-skip-marker-deny.sh"}]}]}}
EOF
git -C "$WORK" init -q -b main "$REPO"
git -C "$REPO" -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m init
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
touch "$REPO/.git/FETCH_HEAD"

echo "=== scenario 1: 4本の同梱と信頼状態不明を別行で報告 ==="
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
RC=$?
[ "$RC" -eq 0 ] && ok "信頼状態を読めなくても exit 0" || ng "信頼状態不明で停止"
for name in check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh codex-skip-marker-deny.sh; do
  grep -qF "hook $name: 含まれる" <<<"$OUT" && ok "$name を確認" || ng "$name の同梱報告がない"
done
grep -qF '信頼状態: 不明' <<<"$OUT" && ok "信頼状態は不明" || ng "不明と出ない"
if grep -qE '保護済み|実発火' <<<"$OUT"; then ng "保護や実発火を推測した"; else ok "保護・実発火を推測しない"; fi
grep -qF '参照 origin/main: あり' <<<"$OUT" && ok "origin/main を確認" || ng "origin/main が見えない"
grep -qF '参照 FETCH_HEAD: あり' <<<"$OUT" && ok "FETCH_HEAD を確認" || ng "FETCH_HEAD が見えない"

echo "=== scenario 2: project hook との二重登録と対照 ==="
grep -qF '二重登録: なし（project hooks.json なし）' <<<"$OUT" && ok "重複なしでは警告しない" || ng "重複なしの対照が違う"
cat > "$REPO/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"command":"\"$(git rev-parse --show-toplevel)\"/scripts/check-branch-pr-status.sh"}]}]}}
EOF
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
grep -qF '二重登録 check-branch-pr-status.sh: 警告' <<<"$OUT" && ok "同じスクリプト名で警告" || ng "二重登録の警告なし"
grep -qF '二重登録 check-local-main-freshness.sh: なし' <<<"$OUT" && ok "他の hook に誤警告しない" || ng "他の hook も重複と誤判定"
printf '{' > "$REPO/.codex/hooks.json"
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
grep -qF '二重登録: 確認不能（project hooks.json を読めない）' <<<"$OUT" && ok "壊れた project 設定を重複なしと読まない" || ng "壊れた project 設定を見逃す"

echo "=== scenario 3: gh 不在なら PR hook は判定しない ==="
BIN="$WORK/bin"
mkdir -p "$BIN"
for tool in bash dirname git jq python3; do ln -s "$(command -v "$tool")" "$BIN/$tool"; done
OUT="$(cd "$REPO" && PATH="$BIN" /bin/bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
grep -qF '実行系 gh: なし' <<<"$OUT" && ok "gh の欠落を報告" || ng "gh の欠落を報告しない"
grep -qF '判定 check-branch-pr-status.sh: 判定しない（gh なし）' <<<"$OUT" && ok "PR hook を判定しない" || ng "PR hook を判定可能と表示"

echo "=== scenario 4: jq が無いと deny は exit 2、警告専用 hook は exit 0 ==="
BIN_NO_JQ="$WORK/bin-no-jq"
mkdir -p "$BIN_NO_JQ"
for tool in bash dirname git python3; do ln -s "$(command -v "$tool")" "$BIN_NO_JQ/$tool"; done
for name in codex-skip-marker-deny.sh check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh; do
  cp "$SCRIPT_DIR/$name" "$PLUGIN/scripts/$name"
done
cp "$SCRIPT_DIR/check-skip-marker-write.sh" "$PLUGIN/scripts/"
RC=0
printf '{"tool_name":"Bash","tool_input":{"command":"touch .claude/.verify-state/x.skip"}}' | PATH="$BIN_NO_JQ" /bin/bash "$PLUGIN/scripts/codex-skip-marker-deny.sh" >/dev/null 2>&1 || RC=$?
[ "$RC" -eq 2 ] && ok "deny hook は exit 2" || ng "deny hook が fail-closed しない"
for name in check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh; do
  RC=0
  (cd "$REPO" && PATH="$BIN_NO_JQ" /bin/bash "$PLUGIN/scripts/$name" codex >/dev/null 2>&1) || RC=$?
  [ "$RC" -eq 0 ] && ok "$name は exit 0" || ng "$name が失敗"
done

[ "$fail" -eq 0 ] || exit 1
echo 'ALL PASSED'
