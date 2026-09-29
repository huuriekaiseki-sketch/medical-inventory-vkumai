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
# ただし **`npx` 経由はサブコマンドを問わず deny する**（下の is_npx_supabase）。
# 2026-09-08 に `npx supabase db reset` がローカルの Supabase 一式を壊した原因は
# 「reset が危険」ではなく「npx が別版の CLI を引いてきた」ことだった。危険度で選り分けず、
# 別版が動く経路そのものを塞ぐ。
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

# WHY(npx 経由の supabase を丸ごと止める): `npx supabase` は npm レジストリから CLI をその場で
# 取ってくるので、Homebrew で入れた版（正本は .supabase-version）と**別物が動く**。
# 2026-09-08 に `npx supabase db reset` が 2.117.0 を引き、その版が要求する postgres イメージの
# 取得に失敗して**ローカルの Supabase 一式（コンテナとボリューム）が消えた**。
# サブコマンドの危険度の問題ではなく「別の版が動くこと」自体が事故の原因なので、
# 読み取り系（status・migration list）も含めて npx 経由は一律で塞ぐ。
# 限界: `npx -p <pkg> supabase ...` のように npx 自身のフラグが**値を取る**形は読み飛ばせず
# 素通りする（フラグを 1 語ずつしか捨てないため）。典型的な手段を塞ぐのが目的で、
# 難読化への完全対策はしない（本スクリプト全体の方針）。
is_npx_supabase() {
  local seg="$1" rest
  [[ "$seg" =~ ^npx([[:space:]]|$) ]] || return 1
  rest="$(printf '%s' "$seg" | sed -E 's/^npx[[:space:]]*//')"
  while [[ "$rest" == -* ]]; do
    rest="$(printf '%s' "$rest" | sed -E 's/^[^[:space:]]+[[:space:]]*//')"
  done
  [[ "$rest" =~ ^supabase([[:space:]@]|$) ]]
}

# WHY: コマンド文字列を「実行されようとしている個々のコマンド」単位（制御演算子 ; & |、
# およびコマンド置換の開始 `$(` / バッククォート で区切られた各セグメント）に分割する
# （issue #633）。区切り文字の種類に関わらず、各セグメントの先頭コマンドだけを見れば
# psql/supabase db execute/db pushの実行を漏れなく拾える。
split_segments() {
  printf '%s' "$1" | tr ';&|`' $'\n' | sed 's/\$(/\n/g'
}

# --- shared: command-prefix (begin) ---
# WHY: 判定はセグメントの先頭（^）で行うので、先頭に何かが付くだけで外れていた
# （2026-09-29 実測: `PGPASSWORD=postgres psql …`・`sudo npm install …` などが素通り）。
# これらはわざと隠した書き方ではなく普通の書き方なので、判定の前に読み飛ばす
# （docs/specs/codex-hook-parity/02-command-prefix.md）。読み飛ばすのは次の 3 種だけ:
#   1. 先頭の空白と、サブシェル / グループの開き括弧（`(` `{`）
#   2. 環境変数の代入（`名前=値`。値は引用符付きでもよい）
#   3. 前置きの 6 語（sudo / env / command / time / nohup / exec）と、そのフラグ
# 限界: 前置きの語のフラグのうち「次の 1 語を値として取る」ものは、下の表に書いたものしか
# 知らない。表に無いフラグが値を取ると、その値をコマンドと読んで外れる。変数に入れてから
# 実行する・別のコマンド（xargs など）に実行させる書き方も対象外（難読化への完全対策はしない）。
# このブロックは check-direct-ddl-execution.sh と check-dependency-change.sh に同じものがある
# （配布の単位が別なので共有 lib にしない）。1 文字でも違うと
# check-direct-ddl-execution.test.sh scenario 34 が落ちる。
PREFIX_LEAD_RE='^[[:space:]({]+(.*)$'
PREFIX_ASSIGN_RE='^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]*)([[:space:]]+(.*))?$'
PREFIX_WORD_RE='^([^[:space:]]*/)?(sudo|env|command|time|nohup|exec)([[:space:]]+(.*))?$'
PREFIX_FLAG_RE='^(-[^[:space:]]*)([[:space:]]+(.*))?$'
PREFIX_NEXT_RE='^[^[:space:]]+([[:space:]]+(.*))?$'
INLINE_SHELL_RE='^([^[:space:]]*/)?(bash|sh|zsh)[[:space:]]+(-.*)$'
INLINE_C_FLAG_RE='^-[A-Za-z]*c$'

# 前置きの語のフラグのうち、次の 1 語を値として取るもの
prefix_value_flag() { # $1=前置きの語 $2=フラグ
  case "$1:$2" in
    sudo:-u|sudo:-g|sudo:-h|sudo:-p|sudo:-C|sudo:-D|sudo:-R|sudo:-T|sudo:-U) return 0 ;;
    sudo:--user|sudo:--group|sudo:--host|sudo:--prompt|sudo:--chdir) return 0 ;;
    env:-u|env:--unset|env:-C|env:--chdir|env:-S|env:--split-string) return 0 ;;
    time:-o|time:--output|time:-f|time:--format) return 0 ;;
    exec:-a) return 0 ;;
  esac
  return 1
}

# セグメントの先頭から前置きを読み飛ばし、実際に動くコマンドから始まる文字列を返す
strip_prefix() {
  local seg="$1" prev="" word rest flag
  while [ "$seg" != "$prev" ]; do
    prev="$seg"
    if [[ "$seg" =~ $PREFIX_LEAD_RE ]]; then
      seg="${BASH_REMATCH[1]}"
    fi
    if [[ "$seg" =~ $PREFIX_ASSIGN_RE ]]; then
      seg="${BASH_REMATCH[3]}"
      continue
    fi
    if [[ "$seg" =~ $PREFIX_WORD_RE ]]; then
      word="${BASH_REMATCH[2]}"
      rest="${BASH_REMATCH[4]}"
      while [[ "$rest" =~ $PREFIX_FLAG_RE ]]; do
        flag="${BASH_REMATCH[1]}"
        rest="${BASH_REMATCH[3]}"
        # `command -v psql` は psql を実行しない（あるかどうかを調べるだけ）
        if [ "$word" = "command" ]; then
          if [ "$flag" = "-v" ] || [ "$flag" = "-V" ]; then
            rest=""
            break
          fi
        fi
        if prefix_value_flag "$word" "$flag"; then
          if [[ "$rest" =~ $PREFIX_NEXT_RE ]]; then
            rest="${BASH_REMATCH[2]}"
          fi
        fi
      done
      seg="$rest"
    fi
  done
  printf '%s' "$seg"
}

# `bash -c "…"` のように、シェルへ文字列で渡されたコマンドを取り出す（該当しなければ空）。
# 取り出した文字列は呼び出し側がもう一度セグメントに分けて判定する（掘るのは 1 段だけ）。
inline_shell_command() {
  local seg="$1" rest flag
  if [[ "$seg" =~ $INLINE_SHELL_RE ]]; then
    rest="${BASH_REMATCH[3]}"
    while [[ "$rest" =~ $PREFIX_FLAG_RE ]]; do
      flag="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[3]}"
      if [[ "$flag" =~ $INLINE_C_FLAG_RE ]]; then
        rest="${rest#[\"\']}"
        rest="${rest%[\"\']}"
        printf '%s' "$rest"
        return 0
      fi
    done
  fi
  return 0
}
# --- shared: command-prefix (end) ---

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

DENY=0
REASON=""

# 前置きを読み飛ばした後のセグメントを判定する。止めるなら DENY / REASON を立てて 0 を返す
check_segment() {
  local seg="$1"
  if [ -z "$seg" ]; then return 1; fi
  # 前置きの後ろが読み取り専用のコマンドなら止めない（`sudo grep psql …`）
  if is_readonly_segment "$seg"; then return 1; fi
  if is_npx_supabase "$seg"; then
    DENY=1
    REASON="npx 経由の supabase は使えません。npx は npm レジストリから CLI を取ってくるため Homebrew で入れた版と別物が動きます（2026-09-08 に npx supabase db reset が 2.117.0 を引き、ローカルの Supabase 一式が壊れました）。npx を外して supabase を直接実行してください（版の正本は .supabase-version）。"
    return 0
  fi
  if [[ "$seg" =~ $DIRECT_EXEC_PATTERN ]]; then
    DENY=1
    REASON="supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。"
    return 0
  elif [[ "$seg" =~ $DB_PUSH_PATTERN ]]; then
    # WHY: --localの有無はセグメント単位で判定する（issue #634）。以前はコマンド文字列
    # 全体への部分文字列一致だったため、無関係な位置に`--local`があるだけで素通りしていた
    # （例: `echo see --local docs; supabase db push`、`db push --local && db push`の2つ目）。
    if [[ "$seg" != *"--local"* ]]; then
      DENY=1
      REASON="supabase db push はフラグ無指定時のデフォルトがリモート(本番)データベースです（--linked・--db-url指定時も同様）。ローカルSupabaseへ適用する場合は明示的に --local を付けてください（例: supabase db push --local）。本番への適用が本当に必要な場合は、人間が手動で実行してください（issue #485）。"
      return 0
    fi
  fi
  return 1
}

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    # WHY: プロセス置換(`done < <(...)`)はmacOS標準のbash 3.2ではset -o pipefail下で
    # 読み込みが空になる事象を実機確認したため、ヒアストリング経由の読み込みに変更している。
    SEGMENTS="$(split_segments "$COMMAND")"
    while IFS= read -r RAW_SEG; do
      SEG="$(printf '%s' "$RAW_SEG" | sed -E 's/^[[:space:]]+//')"
      [ -z "$SEG" ] && continue
      # WHY(前置きを読み飛ばす前に見る): `echo PGPASSWORD=x psql` は psql を実行しない
      is_readonly_segment "$SEG" && continue
      SEG="$(strip_prefix "$SEG")"
      if check_segment "$SEG"; then break; fi
      INNER="$(inline_shell_command "$SEG")"
      if [ -n "$INNER" ]; then
        INNER_SEGMENTS="$(split_segments "$INNER")"
        while IFS= read -r RAW_INNER; do
          if check_segment "$(strip_prefix "$RAW_INNER")"; then break; fi
        done <<< "$INNER_SEGMENTS"
      fi
      if [ "$DENY" -eq 1 ]; then break; fi
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
