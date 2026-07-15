#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook。issue #348: verify-claims.shのエスケープハッチ
# (.claude/.verify-state/<session_id>.skip の作成)を、touch/echo/python等の手段を問わず
# 人間の確認プロンプト(ask)に強制する。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md 「エスケープハッチ(誤検知対策)」節
#
# 標準入力でPreToolUseのhook入力JSON({tool_name, tool_input, cwd, ...})を受け取り、
# 書き込み対象が .claude/.verify-state/*.skip にマッチする場合のみ、
# permissionDecision: "ask" のJSONを標準出力してexit 0する。
# マッチしない場合は何も出力せずexit 0(通常の権限フローに委ねる。allow/denyには関与しない)。
#
# 検知は3系統:
# 1. フルパス一致: command/file_path に ".claude/.verify-state/<name>.skip" という
#    連続した文字列が現れる場合(絶対/相対どちらの書き方でも、途中に何らかの引用符・括弧が
#    前後にあっても部分文字列として一致すればよい)
# 2. コマンド内cd + 相対パス一致(issue #348追加修正): `cd .claude/.verify-state && touch abc.skip`
#    のように、同一コマンド文字列内でディレクトリへ移動してから相対パスで.skipファイルに触る場合。
#    hook実行時点のtool_input.commandはまだ実行前(cdは走っていない)ため、cwdフィールドではなく
#    command文字列自体から「.claude/.verify-state というディレクトリ参照」と「相対パスの.skip
#    トークン」の両方が同じコマンド文字列中に含まれるかを見る。
# 3. cwd起点の相対パス一致(issue #348追加修正): Bashツールはセッション間でcwdが持続するため、
#    事前のBash呼び出しで既に`cd .claude/.verify-state`を実行済みの状態で、別呼び出しとして
#    `touch abc.skip`のみを実行する、といった操作で1系統目の文字列一致をすり抜けられることが
#    実証された。hook入力の`cwd`フィールド(現在の作業ディレクトリの絶対パス)が
#    ".claude/.verify-state" ディレクトリそのもの/配下を指しており、かつcommand/file_pathに
#    スラッシュを含まない(=相対パスらしい)".skip"トークンが含まれる場合も対象とする。
#
# 既知の限界(設計ドキュメントに明記済み):
# - 正規表現によるコマンド文字列マッチのため、変数展開・base64エンコード等で意図的に
#   難読化されたコマンドはすり抜けうる。典型的な手段(touch/echo/cp/mv/python -c/node -e等、
#   コマンド文字列に直接パスが現れるもの)を塞ぐのが目的であり、完全な保証ではない。

FULL_PATH_PATTERN='\.claude/\.verify-state/[^/]+\.skip'
# ディレクトリ参照の後にスラッシュ・空白・&・;・文字列末尾のいずれかが続く(cdの引数として
# 使われる書き方も含めて拾うため、直後に必ずスラッシュが来るとは限らない)。
DIR_REFERENCE_PATTERN='\.claude/\.verify-state([/[:space:]&;]|$)'
CWD_PATTERN='(^|/)\.claude/\.verify-state($|/)'
RELATIVE_SKIP_TOKEN_PATTERN='[^/[:space:]]+\.skip'

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"

TARGET=""
case "$TOOL_NAME" in
  Bash)
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
    ;;
  Write|Edit)
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')"
    ;;
  *)
    exit 0
    ;;
esac

MATCHED=0
if [[ "$TARGET" =~ $FULL_PATH_PATTERN ]]; then
  MATCHED=1
fi
if [[ "$MATCHED" -eq 0 ]] && [[ "$TARGET" =~ $DIR_REFERENCE_PATTERN ]] && [[ "$TARGET" =~ $RELATIVE_SKIP_TOKEN_PATTERN ]]; then
  MATCHED=1
fi
if [[ "$MATCHED" -eq 0 ]] && [[ "$CWD" =~ $CWD_PATTERN ]] && [[ "$TARGET" =~ $RELATIVE_SKIP_TOKEN_PATTERN ]]; then
  MATCHED=1
fi

if [[ "$MATCHED" -eq 1 ]]; then
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "verify-claimsのエスケープハッチ(.skipマーカー)への書き込みです。人間の確認が必要です。"}}'
fi

exit 0
