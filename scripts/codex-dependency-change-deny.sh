#!/usr/bin/env bash
set -euo pipefail

# Codex PreToolUse用: check-dependency-change.sh の ask→deny 変換ラッパー。
#
# WHY: Codex の PreToolUse は permissionDecision: "ask" 未対応（riff-gear で実機検証済み）。
# Claude 側の ask ガードをそのまま登録すると確認プロンプトが出ずに素通りし、Codex 経由で
# 無確認に依存を足せる抜け穴になる。安全側に倒し、Codex 側では一律 deny へ読み替える
# （必要な場合は人間が手動で実行する）。判定ロジックは check-dependency-change.sh（共有正本）に
# 委譲し、このラッパーは出力契約の変換のみを担う（codex-skip-marker-deny.sh と同型。
# docs/agents/claude-codex-coexistence-template.md 原則2・3）。

command -v jq >/dev/null 2>&1 || { echo "jq not found: codex-dependency-change-deny.sh cannot run" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/check-dependency-change.sh"

# WHY(fail-closed): codex-skip-marker-deny.sh と同じ。判定本体が無い・失敗する・読めない結果を
# 返すときは、jq 不在のときと同じ exit 2 に揃える
# （docs/specs/codex-hook-parity/04-wrapper-fail-closed.md）。
fail_closed() {
  echo "codex-dependency-change-deny.sh: $1 守りが効かないので止めました。プラグイン（または scripts/）を入れ直してください。" >&2
  exit 2
}

[ -f "$GUARD" ] && [ -r "$GUARD" ] || fail_closed "判定本体 check-dependency-change.sh が見つかりません（${GUARD}）。"

INPUT="$(cat)"
GUARD_RC=0
OUT="$(printf '%s' "$INPUT" | bash "$GUARD")" || GUARD_RC=$?
[ "$GUARD_RC" -eq 0 ] || fail_closed "判定本体 check-dependency-change.sh が失敗しました（終了コード ${GUARD_RC}）。"

if [ -n "$OUT" ]; then
  printf '%s' "$OUT" | jq empty >/dev/null 2>&1 || fail_closed "判定本体 check-dependency-change.sh の出力を読めません。"
  printf '%s' "$OUT" | jq '
    if .hookSpecificOutput.permissionDecision == "ask" then
      .hookSpecificOutput.permissionDecision = "deny"
      | .hookSpecificOutput.permissionDecisionReason =
          "（Codexはask未対応のためdenyに読み替え）" + .hookSpecificOutput.permissionDecisionReason
          + " 本当に必要な場合は人間が手動で実行してください。"
    else . end'
fi

exit 0
