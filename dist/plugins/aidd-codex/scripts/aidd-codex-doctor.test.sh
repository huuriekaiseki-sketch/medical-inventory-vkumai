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
# WHY: doctor は部品のファイルそのものも見る（仕様書 04）。部品を置かずに走らせると
# 「判定しない（部品なし）」が全行に付き、ほかの欠落（gh なし等）の検査と混ざる。
PARTS=(codex-skip-marker-deny.sh check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh check-skip-marker-write.sh)
install_parts() { for part in "${PARTS[@]}"; do cp "$SCRIPT_DIR/$part" "$PLUGIN/scripts/$part"; chmod 755 "$PLUGIN/scripts/$part"; done; }
install_parts
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
RC=0
printf '{"tool_name":"Bash","tool_input":{"command":"touch .claude/.verify-state/x.skip"}}' | PATH="$BIN_NO_JQ" /bin/bash "$PLUGIN/scripts/codex-skip-marker-deny.sh" >/dev/null 2>&1 || RC=$?
[ "$RC" -eq 2 ] && ok "deny hook は exit 2" || ng "deny hook が fail-closed しない"
for name in check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh; do
  RC=0
  (cd "$REPO" && PATH="$BIN_NO_JQ" /bin/bash "$PLUGIN/scripts/$name" codex >/dev/null 2>&1) || RC=$?
  [ "$RC" -eq 0 ] && ok "$name は exit 0" || ng "$name が失敗"
done

echo "=== scenario 5: 部品のファイルそのものを見る（あり / なし / 実行不可） ==="
# WHY: hooks.json に名前が書いてあっても、スクリプトが無い・実行できないなら hook は動かない。
# 登録の有無だけを見ていると、壊れた導入を「実行前提あり」と報告してしまう（仕様書 04）。
printf '{}' > "$REPO/.codex/hooks.json"
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
for part in "${PARTS[@]}"; do
  grep -qF "部品 $part: あり" <<<"$OUT" && ok "$part は あり" || ng "$part の部品行が無い"
done
grep -qF '判定 codex-skip-marker-deny.sh: 実行前提あり' <<<"$OUT" && ok "揃っていれば実行前提あり（対照）" || ng "揃っているのに判定しない"

chmod 644 "$PLUGIN/scripts/check-branch-tool-ownership.sh"
rm "$PLUGIN/scripts/check-local-main-freshness.sh"
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
RC=$?
[ "$RC" -eq 0 ] && ok "部品が欠けていても doctor 自体は exit 0" || ng "doctor が途中で止まる"
grep -qF '部品 check-branch-tool-ownership.sh: 実行不可' <<<"$OUT" && ok "実行ビットが無い部品を報告" || ng "実行不可を見逃す"
grep -qF '部品 check-local-main-freshness.sh: なし' <<<"$OUT" && ok "消えた部品を報告" || ng "欠落を見逃す"
grep -qE '判定 check-branch-tool-ownership\.sh: 判定しない（.*実行不可' <<<"$OUT" && ok "実行不可の hook は判定しない" || ng "実行できない hook を実行前提ありと表示"
grep -qE '判定 check-local-main-freshness\.sh: 判定しない（.*部品なし' <<<"$OUT" && ok "部品の無い hook は判定しない" || ng "部品の無い hook を実行前提ありと表示"
grep -qF '部品 check-branch-pr-status.sh: あり' <<<"$OUT" && ok "ほかの部品に誤報しない" || ng "無関係な部品まで欠落と報告"
install_parts

rm "$PLUGIN/scripts/check-skip-marker-write.sh"
OUT="$(cd "$REPO" && bash "$PLUGIN/scripts/aidd-codex-doctor.sh")"
grep -qF '部品 check-skip-marker-write.sh: なし' <<<"$OUT" && ok "判定本体の欠落を報告" || ng "判定本体の欠落を見逃す"
grep -qF '部品 codex-skip-marker-deny.sh: あり' <<<"$OUT" && ok "ラッパーは あり のまま" || ng "ラッパーまで欠落と報告"
grep -qE '判定 codex-skip-marker-deny\.sh: 判定しない（.*判定本体なし' <<<"$OUT" && ok "判定本体の無いラッパーは判定しない" || ng "判定本体が無いのに実行前提ありと表示"
if grep -qE '保護済み|実発火' <<<"$OUT"; then ng "保護や実発火を推測した"; else ok "保護・実発火を推測しない"; fi
install_parts

[ "$fail" -eq 0 ] || exit 1
echo 'ALL PASSED'
