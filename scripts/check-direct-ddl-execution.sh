#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトはjqでhook入力JSONをパースする。jq未インストール環境では
# set -euo pipefail下でjq呼び出しがexit 127となりスクリプトごと死に、
# denyゲートが暗黙にfail-openになっていた（issue #636）。「安全と証明されない限り拒否」
# （本ファイル既存コメント参照）の設計方針に合わせ、jq不在時もfail-closed
# （exit 2でブロック側に倒す）にする。
command -v jq >/dev/null 2>&1 || { echo "jq not found: check-direct-ddl-execution.sh cannot run" >&2; exit 2; }

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
# 以前は境界文字クラスが`(^|[;&[:space:]])`のみで、パイプ(`|`)やコマンド置換(`$(`・
# バッククォート)を挟むと境界条件を満たさずすり抜けた（issue #633: `cat schema.sql|psql mydb`
# や`$(psql ...)`）。判定はコマンド全体への正規表現一発ではなく、「実行単位のセグメント」に
# 分割してからセグメント先頭に対して判定する方式に変更した（下記split_segments）ため、
# 各パターンはセグメント先頭アンカー(^)のみを見ればよい。
# パス前置（/opt/homebrew/bin/supabase・./node_modules/.bin/supabase等）の迂回経路も塞ぐため、
# supabaseの前に任意の非空白パスプレフィックス ([^[:space:]]*/)? を許容する（psqlの/psql対応と同型）。
DIRECT_EXEC_PATTERN='^(npx[[:space:]]+)?([^[:space:]]*/)?supabase[[:space:]]+db[[:space:]]+execute([[:space:]]|$)|^psql([[:space:]]|$)|/psql([[:space:]]|$)'
# issue #485: supabase db push はフラグ無指定時のデフォルトがリモート(linkedプロジェクト)。
# --local が明示されていなければ、bare実行・--linked・--db-url いずれであっても一律denyする。
DB_PUSH_PATTERN='^(npx[[:space:]]+)?([^[:space:]]*/)?supabase[[:space:]]+db[[:space:]]+push([[:space:]]|$)'

# WHY: `which psql`・`man psql`・`git grep psql`のような読み取り専用の前置コマンドは
# psqlを実行しないため誤denyしない（issue #633）。本スクリプトの既存方針（完全な難読化対策は
# 不要、典型的な手段を塞ぐのが目的）を踏襲し、代表的な読み取りコマンドのみ除外する。
is_readonly_segment() {
  local seg="$1" first_word second_word
  first_word="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')"
  case "$first_word" in
    which|man|type|grep|egrep|fgrep) return 0 ;;
    git)
      second_word="$(printf '%s' "$seg" | awk '{print $2}')"
      [[ "$second_word" == "grep" ]]
      ;;
    *) return 1 ;;
  esac
}

# WHY: コマンド文字列を「実行されようとしている個々のコマンド」単位（制御演算子 ; & |、
# およびコマンド置換の開始 `$(` / バッククォート で区切られた各セグメント）に分割する
# （issue #633）。区切り文字の種類に関わらず、各セグメントの先頭コマンドだけを見れば
# psql/supabase db execute/db pushの実行を漏れなく拾える。
split_segments() {
  printf '%s' "$1" | tr ';&|`' $'\n' | sed 's/\$(/\n/g'
}

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

DENY=0
REASON=""

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    # WHY: プロセス置換(`done < <(...)`)はmacOS標準のbash 3.2ではset -o pipefail下で
    # 読み込みが空になる事象を実機確認したため、ヒアストリング経由の読み込みに変更している。
    SEGMENTS="$(split_segments "$COMMAND")"
    while IFS= read -r RAW_SEG; do
      SEG="$(printf '%s' "$RAW_SEG" | sed -E 's/^[[:space:]]+//')"
      [ -z "$SEG" ] && continue
      is_readonly_segment "$SEG" && continue
      if [[ "$SEG" =~ $DIRECT_EXEC_PATTERN ]]; then
        DENY=1
        REASON="supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。"
        break
      elif [[ "$SEG" =~ $DB_PUSH_PATTERN ]]; then
        # WHY: --localの有無はセグメント単位で判定する（issue #634）。以前はコマンド文字列
        # 全体への部分文字列一致だったため、無関係な位置に`--local`があるだけで素通りしていた
        # （例: `echo see --local docs; supabase db push`、`db push --local && db push`の2つ目）。
        if [[ "$SEG" != *"--local"* ]]; then
          DENY=1
          REASON="supabase db push はフラグ無指定時のデフォルトがリモート(本番)データベースです（--linked・--db-url指定時も同様）。ローカルSupabaseへ適用する場合は明示的に --local を付けてください（例: supabase db push --local）。本番への適用が本当に必要な場合は、人間が手動で実行してください（issue #485）。"
          break
        fi
      fi
    done <<< "$SEGMENTS"
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
