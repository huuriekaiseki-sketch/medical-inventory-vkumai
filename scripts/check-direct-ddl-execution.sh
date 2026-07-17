#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook。issue #444（issue #339「直接DDL実行禁止は事後のドリフト検知(issue #305)
# のみで、実行しようとした瞬間に止める事前ブロックはない」の機械化・優先度2候補）。
#
# docs/agents/common.md「DBスキーマ変更ルール」の
# 「execute_sql等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）」を、
# ブロックせず警告するだけのPreToolUse hookとは異なり、実行そのものをdenyする形で機械強制する。
#
# 対象は「migrationファイルを経由しないアドホックなSQL実行」に絞る:
# - Bash経由の `supabase db execute` / `psql` 直接呼び出し
# - MCPツール経由の execute_sql系ツール（例: mcp__supabase__execute_sql）。このリポジトリの
#   .mcp.jsonには現時点でSupabase MCPサーバーは定義されていないが、個人設定や将来の追加で
#   有効化された場合にBash側のガードを素通りする抜け道になるため、matcherレベルで先回りして
#   塞ぐ（issue #444レビュー時の指摘）。サーバー名を固定しない正規表現で、将来サーバー名が
#   変わっても拾えるようにしている。
#
# `supabase db push` / `db reset` / `functions deploy` 等は対象外（migrationファイルを適用する
# 正規の手段そのもの、またはDB操作でも「直接DDL適用」に該当しないため）。既にsettings.jsonで
# askとして人間の確認を要求している。
#
# SQL内容の解析（DDL文かどうかの判定）はしない。コマンド/ツール自体を丸ごとdenyする
# （内容ベースの判定は誤検知・すり抜け双方のリスクが高いため。scripts/check-skip-marker-write.sh
# と同じ設計方針）。
#
# 対象ツール: Bash / mcp__*execute_sql*（case文のパターン）。.claude/settings.jsonのmatcher
# （"Bash|mcp__.*execute_sql"）と本スクリプトのcase文の両方を揃える必要がある。

# WHY: bashの[[ =~ ]]（ERE）は\bを単語境界として解釈しない(実機確認済み: パターンごと
# 静かにマッチしなくなる)。[[:space:]]|$ で明示的に境界を表現する。
DIRECT_EXEC_PATTERN='(^|[;&[:space:]])(npx[[:space:]]+)?supabase[[:space:]]+db[[:space:]]+execute([[:space:]]|$)|(^|[;&[:space:]])psql([[:space:]]|$)'

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

DENY=0
REASON=""

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    if [[ "$COMMAND" =~ $DIRECT_EXEC_PATTERN ]]; then
      DENY=1
      REASON="supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db pushで適用してください。"
    fi
    ;;
  mcp__*execute_sql*)
    DENY=1
    REASON="MCPツール経由のSQL直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成してください。"
    ;;
  *)
    exit 0
    ;;
esac

if [[ "$DENY" -eq 1 ]]; then
  jq -n --arg reason "$REASON" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
fi

exit 0
