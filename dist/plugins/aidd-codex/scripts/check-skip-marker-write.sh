#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトはjqでhook入力JSONをパースする。jq未インストール環境では
# set -euo pipefail下でjq呼び出しがexit 127となりスクリプトごと死に、
# askゲートが暗黙にfail-openになっていた（issue #636）。denyゲートに準ずる
# 重要度のためfail-closed（jq不在時はexit 2でブロック側に倒す）にする。
command -v jq >/dev/null 2>&1 || { echo "jq not found: check-skip-marker-write.sh cannot run" >&2; exit 2; }

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
# 対象ツール: Bash / Write / Edit / MultiEdit(いずれもtool_input.file_pathまたはcommandに
# 書き込み先パスが現れる)と、Codex のファイル編集 apply_patch(Codex 側の matcher では
# Edit / Write がそのエイリアスとして効く)。.claude/settings.jsonのmatcherと本スクリプトのcase文の両方を
# 揃える必要がある(片方だけ直しても検知が効かない)。NotebookEdit等、file_path以外の
# パラメータ名で書き込み先を指定するツールが将来追加された場合は同様に追随が必要。
#
# 既知の限界(設計ドキュメントに明記済み):
# - 正規表現によるコマンド文字列マッチのため、変数展開・base64エンコード等で意図的に
#   難読化されたコマンドはすり抜けうる。典型的な手段(touch/echo/cp/mv/python -c/node -e等、
#   コマンド文字列に直接パスが現れるもの)を塞ぐのが目的であり、完全な保証ではない。

FULL_PATH_PATTERN='\.claude/\.verify-state/[^/]+\.skip'
# 「cd」でディレクトリへ移動する操作に限定する(単に ls/cat/grep 等でディレクトリ名に
# 言及しているだけの読み取り系コマンドと、無関係な場所にある別の *.skip ファイルへの
# 操作が同一コマンド文字列中にたまたま同居しているだけの誤検知(false positive)を避けるため)。
# 直前が行頭・空白・;・& のいずれかで始まる「cd <path>」の形のみを対象とする。
DIR_REFERENCE_PATTERN='(^|[;&[:space:]])cd[[:space:]]+\.claude/\.verify-state([/[:space:]&;]|$)'
CWD_PATTERN='(^|/)\.claude/\.verify-state($|/)'
RELATIVE_SKIP_TOKEN_PATTERN='[^/[:space:]]+\.skip'

# WHY(apply_patch): Codex はファイル編集を tool_name: "apply_patch" で渡し、書き込み先は
# tool_input.file_path ではなく tool_input.command（パッチ本文）のヘッダ行に入る。Claude の形
# （Write / Edit + file_path）しか知らなかったため、Codex のファイル編集は下の `*) exit 0` に落ちて
# 丸ごと素通りしていた（2026-09-29 実測。docs/specs/codex-hook-parity/01-apply-patch.md）。
# ヘッダ行だけを読み、本文（+ / - / 空白で始まる行）は見ない。本文まで見ると、説明文書に
# このパスを書くだけの編集を止めてしまう。
# 限界: ヘッダが 1 行も取れない apply_patch は沈黙する（判定不能を止める側に倒すと、
# Codex のファイル編集が全部止まる）。パッチの書式が変わったらここが先に外れる。
extract_patch_paths() {
  printf '%s\n' "$1" \
    | sed -n -E 's/^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/\2/p' \
    | sed -E 's/[[:space:]]+$//'
}

# WHY(読むだけの操作は見送る): コマンド文字列のどこかにパスが出ていれば止めていたので、
# `cat …/x.skip` のように中身を読むだけでも止まっていた（2026-09-29 実測）。Claude では確認を
# 1 回押せば済むが、Codex は確認を出せず、止まったら人が手で実行するしかない
# （docs/specs/codex-hook-parity/03-readonly-false-deny.md）。
# これは守りを緩める変更なので、通すものは決め打ちにする:
#   - セグメントの先頭が下の 8 語のどれかで、
#   - かつ、そのセグメントに書き込み先の指定（`>`）も `tee` も含まれないときだけ見送る
# `2>/dev/null` のような無害な `>` でも見送らない（緩めすぎない側に倒す）。
# `sudo cat …` のように前置きが付いたものも見送らない。
# 見送らなかったセグメントだけを繋ぎ直して、これまでと同じ 3 系統の判定に渡す
# （`cd .claude/.verify-state && touch a.skip` は 2 つのセグメントにまたがるので、
# セグメントごとに判定すると外れる）。
split_segments() {
  printf '%s' "$1" | tr ';&|`' $'\n' | sed 's/\$(/\n/g'
}

drop_readonly_segments() {
  local seg trimmed first out=""
  while IFS= read -r seg; do
    trimmed="${seg#"${seg%%[![:space:]]*}"}"
    if [ -z "$trimmed" ]; then continue; fi
    first="${trimmed%%[[:space:]]*}"
    case "$first" in
      cat|ls|head|tail|wc|stat|file|grep)
        case "$trimmed" in
          *">"*|*tee*) ;;
          *) continue ;;
        esac
        ;;
    esac
    out="${out}${out:+ ; }${trimmed}"
  done <<< "$(split_segments "$1")"
  printf '%s' "$out"
}

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"

TARGET=""
MATCHED=0
case "$TOOL_NAME" in
  Bash)
    TARGET="$(drop_readonly_segments "$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')")"
    ;;
  Write|Edit|MultiEdit)
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')"
    ;;
  apply_patch)
    # WHY(cwd と繋いでから見る): パッチのパスは cwd からの相対で書かれる。cwd が .claude や
    # .claude/.verify-state のときは、パス単体には ".claude/.verify-state/" が現れない。
    PATCH_PATHS="$(extract_patch_paths "$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')")"
    while IFS= read -r PATCH_PATH; do
      [ -z "$PATCH_PATH" ] && continue
      case "$PATCH_PATH" in
        /*) RESOLVED="$PATCH_PATH" ;;
        *)  RESOLVED="${CWD:+$CWD/}$PATCH_PATH" ;;
      esac
      if [[ "$RESOLVED" =~ $FULL_PATH_PATTERN ]]; then
        MATCHED=1
        break
      fi
    done <<< "$PATCH_PATHS"
    ;;
  *)
    exit 0
    ;;
esac

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
