#!/usr/bin/env bash
set -euo pipefail

# WHY: jq 不在時は ask ゲートが無言で fail-open になる（issue #636 と同型）。
#      deny ゲートに準ずる重要度のため fail-closed（exit 2 でブロック側に倒す）。
command -v jq >/dev/null 2>&1 || { echo "jq not found: check-dependency-change.sh cannot run" >&2; exit 2; }

# PreToolUse hook（ask）。npm パッケージの追加・更新・削除を「部品を増やす作業」ではなく
# 「実行する第三者コードと依存関係を増やす設計判断」として、人間の明示的確認を要求する
# （docs/agents/known-failure-patterns.md「依存関係層」、2026-09-04）。
#
# 背景: AI や共同作業者が用途を説明できないパッケージを package.json に足しても、アプリは普通に
# 動き、追加分は大量の lockfile 差分や間接依存に紛れる。事後の依存監査（npm audit）は既知の
# 脆弱性しか見ないので、「追加する瞬間」に理由・代替案・影響を人が確認する入口が要る。
#
# 対象:
# - Bash: `npm install|i|add|uninstall|remove|update <パッケージ名…>`、`yarn add|remove|upgrade …`、
#   `pnpm add|remove|update …` のように、パッケージ名（非フラグ引数）を伴う依存変更コマンド。
#   引数がフラグだけ（`npm install`、`npm install --package-lock-only`）や `npm ci` は lockfile
#   どおりに入れ直すだけなので対象外。which / man / grep / git grep 等の読み取り系も対象外
# - Write / Edit / MultiEdit: package.json / package-lock.json への書き込み
# - apply_patch（Codex のファイル編集）: 同上。Codex 側の matcher では Edit / Write が
#   apply_patch のエイリアスとして効くので、matcher は変えていない
#
# 判定はコマンド文字列を実行単位（; & | $( `）に分割してセグメント先頭で行う
# （check-direct-ddl-execution.sh と同型、issue #633）。難読化への完全対策は目的にしない。
# Codex 側は ask 未対応のため scripts/codex-dependency-change-deny.sh が deny へ読み替える。
#
# .claude/settings.json の matcher（"Bash|Write|Edit|MultiEdit"）と本スクリプトの case 文の
# 両方を揃える必要がある。

NPM_SUBCMDS='install|i|in|ins|inst|isntall|add|uninstall|un|unlink|remove|rm|r|update|up|upgrade|udpate'
NPM_PATTERN="^([^[:space:]]*/)?npm[[:space:]]+($NPM_SUBCMDS)([[:space:]]|$)"
YARN_PATTERN='^([^[:space:]]*/)?yarn[[:space:]]+(add|remove|upgrade|up)([[:space:]]|$)'
PNPM_PATTERN='^([^[:space:]]*/)?pnpm[[:space:]]+(add|remove|rm|update|up)([[:space:]]|$)'

split_segments() {
  printf '%s' "$1" | tr ';&|`' $'\n' | sed 's/\$(/\n/g'
}

is_readonly_segment() {
  local seg="$1" first_word second_word
  first_word="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')"
  case "$first_word" in
    which|man|type|grep|egrep|fgrep|echo|printf|cat) return 0 ;;
    git)
      second_word="$(printf '%s' "$seg" | awk '{print $2}')"
      [[ "$second_word" == "grep" ]]
      ;;
    *) return 1 ;;
  esac
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

# サブコマンドより後ろに「フラグでない引数」（= パッケージ名）が 1 つ以上あるか
has_package_arg() {
  local seg="$1" word i=0
  for word in $seg; do
    i=$((i+1))
    [ "$i" -le 2 ] && continue          # 1=npm/yarn/pnpm 2=サブコマンド
    case "$word" in
      -*) continue ;;
      *) return 0 ;;
    esac
  done
  return 1
}

# WHY(apply_patch): Codex はファイル編集を tool_name: "apply_patch" で渡し、書き込み先は
# tool_input.file_path ではなく tool_input.command（パッチ本文）のヘッダ行に入る。Claude の形
# （Write / Edit + file_path）しか知らなかったため、Codex が package.json を直接編集しても
# 下の `*) exit 0` に落ちて素通りしていた（2026-09-29 実測。
# docs/specs/codex-hook-parity/01-apply-patch.md）。
# ヘッダ行だけを読み、本文（+ / - / 空白で始まる行）は見ない。本文まで見ると、説明文書に
# 「package.json」と書くだけの編集を止めてしまう。
# 限界: ヘッダが 1 行も取れない apply_patch は沈黙する（判定不能を止める側に倒すと、
# Codex のファイル編集が全部止まる）。
# check-skip-marker-write.sh にも同じ関数がある（split_segments と同じく、配布の単位が別なので
# 共有 lib にせず 2 本に置く）。片方を直したらもう片方も直す。
extract_patch_paths() {
  printf '%s\n' "$1" \
    | sed -n -E 's/^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/\2/p' \
    | sed -E 's/[[:space:]]+$//'
}

# 書き込み先が package.json / package-lock.json なら ASK と REASON を立てて 0 を返す
check_manifest_path() {
  local base
  base="$(basename "$1")"
  case "$base" in
    package.json|package-lock.json)
      ASK=1
      REASON="$base への直接編集は依存関係の変更です（scripts の変更だけであっても、依存に触れていないことを人が確認します）。依存を足す場合は用途・代替案・権限/環境変数/DB への影響・固定する版と出所を報告して承認を得てから進めてください。"
      return 0
      ;;
  esac
  return 1
}

# WHY: `npm --prefix web install foo` のように、npm とサブコマンドの間にフラグが入ると、
# 「npm の直後がサブコマンド」を前提にした判定から外れる（2026-09-29 実測で素通り）。
# サブコマンドより前のフラグを読み飛ばして「npm install foo」の形に直す。
# 次の 1 語を値として取るフラグは、下の 4 つしか知らない（全フラグを正しく読むのは無理なので
# 代表だけにする）。`--registry=URL` のように = で繋いだ形は 1 語なのでそのまま読み飛ばせる。
# 限界: `yarn --cwd web add foo`・`pnpm --filter web add zod` のように、この 4 つ以外の
# フラグが値を取ると、その値をサブコマンドと読んで外れる。
PM_LEADING_FLAG_RE='^(([^[:space:]]*/)?(npm|yarn|pnpm))[[:space:]]+(-.*)$'
normalize_pm_flags() {
  local seg="$1" tool rest flag
  if [[ "$seg" =~ $PM_LEADING_FLAG_RE ]]; then
    tool="${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[4]}"
    while [[ "$rest" =~ $PREFIX_FLAG_RE ]]; do
      flag="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[3]}"
      case "$flag" in
        --prefix|--workspace|-w|--registry)
          if [[ "$rest" =~ $PREFIX_NEXT_RE ]]; then
            rest="${BASH_REMATCH[2]}"
          fi
          ;;
      esac
    done
    seg="$tool $rest"
  fi
  printf '%s' "$seg"
}

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

ASK=0
REASON=""

# 前置きを読み飛ばした後のセグメントを判定する。確認が要るなら ASK / REASON を立てて 0 を返す
check_segment() { # $1=前置きを読み飛ばしたセグメント $2=理由文に出す元のセグメント
  local seg="$1" shown="$2"
  if [ -z "$seg" ]; then return 1; fi
  # 前置きの後ろが読み取り専用のコマンドなら確認しない（`sudo grep "npm install" …`）
  if is_readonly_segment "$seg"; then return 1; fi
  seg="$(normalize_pm_flags "$seg")"
  if [[ "$seg" =~ $NPM_PATTERN ]] || [[ "$seg" =~ $YARN_PATTERN ]] || [[ "$seg" =~ $PNPM_PATTERN ]]; then
    if has_package_arg "$seg"; then
      ASK=1
      REASON="依存パッケージの追加・更新・削除は「実行する第三者コードと依存関係を増やす設計判断」です。実行前に (1) 用途と代替案（既存の依存や標準 API で足りないか）、(2) 権限・環境変数・DB への影響、(3) 固定する版と出所（registry.npmjs.org か）、を報告して承認を得てください。実行後は package.json / package-lock.json の差分、npm ci、npm audit --omit=dev --audit-level=high の結果と、失敗時のロールバック方法を引き継ぎメモ 00「依存の変更」に書きます。コマンド: $shown"
      return 0
    fi
  fi
  return 1
}

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    SEGMENTS="$(split_segments "$COMMAND")"
    while IFS= read -r RAW_SEG; do
      SEG="$(printf '%s' "$RAW_SEG" | sed -E 's/^[[:space:]]+//')"
      [ -z "$SEG" ] && continue
      # WHY(前置きを読み飛ばす前に見る): `echo CI=1 npm install foo` は npm を実行しない
      is_readonly_segment "$SEG" && continue
      STRIPPED="$(strip_prefix "$SEG")"
      if check_segment "$STRIPPED" "$SEG"; then break; fi
      INNER="$(inline_shell_command "$STRIPPED")"
      if [ -n "$INNER" ]; then
        INNER_SEGMENTS="$(split_segments "$INNER")"
        while IFS= read -r RAW_INNER; do
          if check_segment "$(strip_prefix "$RAW_INNER")" "$SEG"; then break; fi
        done <<< "$INNER_SEGMENTS"
      fi
      if [ "$ASK" -eq 1 ]; then break; fi
    done <<< "$SEGMENTS"
    ;;
  Write|Edit|MultiEdit)
    FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')"
    check_manifest_path "$FILE_PATH" || true
    ;;
  apply_patch)
    # 1 つのパッチに複数のファイルが入る。Codex は編集の一部だけを止められないので、
    # 1 つでも該当したら全体を ask にする。
    PATCH_PATHS="$(extract_patch_paths "$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')")"
    while IFS= read -r PATCH_PATH; do
      [ -z "$PATCH_PATH" ] && continue
      if check_manifest_path "$PATCH_PATH"; then break; fi
    done <<< "$PATCH_PATHS"
    ;;
  *)
    exit 0
    ;;
esac

if [[ "$ASK" -eq 1 ]]; then
  jq -n --arg reason "$REASON" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $reason}}'
fi

exit 0
