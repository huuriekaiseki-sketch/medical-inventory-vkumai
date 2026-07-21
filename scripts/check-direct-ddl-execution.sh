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
# `db reset` / `functions deploy` 等は対象外（`db reset`はフラグ無指定時デフォルトでローカルを
# 対象とするため危険ではない。`--linked`明示時のみ危険だが本スクリプトのスコープ外）。
# 既にsettings.jsonでaskとして人間の確認を要求している。
#
# `supabase db push`のみ例外的に本スクリプトの対象に含める（issue #485）。
# `supabase db push --help`で確認した通り、この一つだけ他のsupabase dbサブコマンドと非対称に
# **フラグ無指定時のデフォルトがリモート（linkedプロジェクト）**（"Push new migrations to the
# remote database"）。このリポジトリはリンク済みプロジェクトref（本番Supabase）が
# supabase/.temp/project-refに存在するため、`--local`を付け忘れた素の`supabase db push`は
# 本番へ直接マイグレーションを適用してしまう。aidd-phase2.js Integrateフェーズの
# integratorエージェント（無人でWorkflow内から実行される）がこれを踏むと、settings.jsonの
# ask許可リストが機能しない実行コンテキスト（bypassPermissions等）では人間の確認なしに
# 本番スキーマが変更されうる（PreToolUse denyはbypassPermissions下でも効くことが実機検証済み。
# docs/agents配下の過去セッション検証記録参照）。`--local`フラグの有無だけで判定する
# （`--local`が無ければbare実行・`--linked`明示・`--db-url`のいずれであっても一律deny。
# 「安全と証明されない限り拒否」の設計）。
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
# issue #485: supabase db push はフラグ無指定時のデフォルトがリモート(linkedプロジェクト)。
# --local が明示されていなければ、bare実行・--linked・--db-url いずれであっても一律denyする。
DB_PUSH_PATTERN='(^|[;&[:space:]])(npx[[:space:]]+)?supabase[[:space:]]+db[[:space:]]+push([[:space:]]|$)'

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

DENY=0
REASON=""

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    if [[ "$COMMAND" =~ $DIRECT_EXEC_PATTERN ]]; then
      DENY=1
      REASON="supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。"
    elif [[ "$COMMAND" =~ $DB_PUSH_PATTERN ]] && [[ "$COMMAND" != *"--local"* ]]; then
      DENY=1
      REASON="supabase db push はフラグ無指定時のデフォルトがリモート(本番)データベースです（--linked・--db-url指定時も同様）。ローカルSupabaseへ適用する場合は明示的に --local を付けてください（例: supabase db push --local）。本番への適用が本当に必要な場合は、人間が手動で実行してください（issue #485）。"
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
