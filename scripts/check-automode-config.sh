#!/usr/bin/env bash
set -euo pipefail

# SessionStart hookから呼ばれる。issue #439: autoMode(hard_deny)による医療データ外部送信・
# RLS無効化の無条件ブロックは、公式仕様上ユーザー個人の~/.claude/settings.jsonでしか
# 有効にならず（.claude/settings.json・settings.local.jsonからは読まれない設計。
# 出典: https://code.claude.com/docs/en/auto-mode-config.md
# 「Where the classifier reads configuration」）、このリポジトリにコミットして全員へ
# 強制することができない。docs/agents/common.mdへの文書化だけでは「書いたのに
# 気づかれない」という同型の問題（issue #423の発端になったloop-observability記録漏れ等）を
# 繰り返すリスクがあるため、check-otel-collector-status.shと同じパターンで
# 「設定し忘れても気づける」形の検知を追加する。
#
# block（session開始そのものの停止）はできない前提のためwarningのみ。autoModeを
# 個人設定として導入するかどうかの判断自体は人間に委ねる（強制はしない）。
#
# テスト容易性のため、ユーザー設定ファイルのパスは環境変数で上書き可能にしている
# （デフォルトは $HOME/.claude/settings.json）。

SETTINGS_PATH="${CLAUDE_USER_SETTINGS_PATH:-$HOME/.claude/settings.json}"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

if [ ! -f "$SETTINGS_PATH" ]; then
  HAS_HARD_DENY="false"
else
  HAS_HARD_DENY="$(jq -r '(.autoMode.hard_deny // []) | length > 0' "$SETTINGS_PATH" 2>/dev/null || echo "false")"
fi

if [ "$HAS_HARD_DENY" = "true" ]; then
  exit 0
fi

MSG="autoMode(hard_deny)による医療データ外部送信・RLS無効化の無条件ブロックが、個人設定(${SETTINGS_PATH})に見当たりません。プロジェクト側の設定ファイルでは強制できない仕様のため、有効化したい場合は docs/agents/common.md の推奨autoMode設定を各自の ~/.claude/settings.json に追加してください（任意、issue #439）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
