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

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"

ASK=0
REASON=""

case "$TOOL_NAME" in
  Bash)
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    SEGMENTS="$(split_segments "$COMMAND")"
    while IFS= read -r RAW_SEG; do
      SEG="$(printf '%s' "$RAW_SEG" | sed -E 's/^[[:space:]]+//')"
      [ -z "$SEG" ] && continue
      is_readonly_segment "$SEG" && continue
      if [[ "$SEG" =~ $NPM_PATTERN ]] || [[ "$SEG" =~ $YARN_PATTERN ]] || [[ "$SEG" =~ $PNPM_PATTERN ]]; then
        if has_package_arg "$SEG"; then
          ASK=1
          REASON="依存パッケージの追加・更新・削除は「実行する第三者コードと依存関係を増やす設計判断」です。実行前に (1) 用途と代替案（既存の依存や標準 API で足りないか）、(2) 権限・環境変数・DB への影響、(3) 固定する版と出所（registry.npmjs.org か）、を報告して承認を得てください。実行後は package.json / package-lock.json の差分、npm ci、npm audit --omit=dev --audit-level=high の結果と、失敗時のロールバック方法を引き継ぎメモ 00「依存の変更」に書きます（docs/agents/known-failure-patterns.md「依存関係層」）。コマンド: $SEG"
          break
        fi
      fi
    done <<< "$SEGMENTS"
    ;;
  Write|Edit|MultiEdit)
    FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')"
    BASENAME="$(basename "$FILE_PATH")"
    case "$BASENAME" in
      package.json|package-lock.json)
        ASK=1
        REASON="$BASENAME への直接編集は依存関係の変更です（scripts の変更だけであっても、依存に触れていないことを人が確認します）。依存を足す場合は用途・代替案・権限/環境変数/DB への影響・固定する版と出所を報告して承認を得てから進めてください（docs/agents/known-failure-patterns.md「依存関係層」）。"
        ;;
    esac
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
