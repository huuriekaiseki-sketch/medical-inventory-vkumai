#!/usr/bin/env bash
set -euo pipefail

# Codex PreToolUse用: check-skip-marker-write.sh のask→deny変換ラッパー。
#
# WHY: CodexのPreToolUseは permissionDecision: "ask" 未対応（riff-gearでの実機検証済み）。
# Claude側でask（人間確認）のガードをCodexにそのまま登録すると、確認プロンプトが出ずに
# 素通りし、Codex経由でClaude側の検証機構（.claude/.verify-state のskipマーカー）を
# 無確認で書き換えられる抜け穴になる。安全側に倒し、Codex側では一律denyへ読み替える
# （必要な場合は人間が手動で操作する）。
#
# 判定ロジック自体は check-skip-marker-write.sh（共有正本）に委譲する。判定を複製すると
# 片側だけ修正されて乖離するため、このラッパーは「出力契約の変換」のみを担う
# （docs/agents/claude-codex-coexistence-template.md 原則2・3）。

command -v jq >/dev/null 2>&1 || { echo "jq not found: codex-skip-marker-deny.sh cannot run" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/check-skip-marker-write.sh"

# WHY(fail-closed): このラッパーは判定を本体に丸投げしている。本体が無い・失敗する・
# 読めない結果を返すとき、以前は rc=127 / 1 / 5 で抜けるだけだった（2026-09-29 実測）。
# Codex が exit 2 以外の失敗を「止める」と扱うかは確認できていないので、守りが効いていない
# まま作業が進まないよう、jq 不在のときと同じ exit 2 に揃える
# （docs/specs/codex-hook-parity/04-wrapper-fail-closed.md）。
fail_closed() {
  echo "codex-skip-marker-deny.sh: $1 守りが効かないので止めました。プラグイン（または scripts/）を入れ直してください。" >&2
  exit 2
}

[ -f "$GUARD" ] && [ -r "$GUARD" ] || fail_closed "判定本体 check-skip-marker-write.sh が見つかりません（$GUARD）。"

INPUT="$(cat)"
GUARD_RC=0
OUT="$(printf '%s' "$INPUT" | bash "$GUARD")" || GUARD_RC=$?
[ "$GUARD_RC" -eq 0 ] || fail_closed "判定本体 check-skip-marker-write.sh が失敗しました（終了コード $GUARD_RC）。"

if [ -n "$OUT" ]; then
  printf '%s' "$OUT" | jq empty >/dev/null 2>&1 || fail_closed "判定本体 check-skip-marker-write.sh の出力を読めません。"
  printf '%s' "$OUT" | jq '
    if .hookSpecificOutput.permissionDecision == "ask" then
      .hookSpecificOutput.permissionDecision = "deny"
      | .hookSpecificOutput.permissionDecisionReason =
          "（Codexはask未対応のためdenyに読み替え）" + .hookSpecificOutput.permissionDecisionReason
          + " 本当に必要な場合は人間が手動で実行してください。"
    else . end'
fi

exit 0
