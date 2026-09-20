#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #713。読み取り専用ロールのサブエージェント（sweep-* / reviewer / completeness-critic /
#      adversarial-verify / judge-panel）は frontmatter で `tools: Read, Bash` としているが、Bash が
#      あれば `sed -i`・リダイレクト・`rm`・`git checkout` 等で書き込めてしまい、「読み取り専用」は
#      プロンプトの自然言語指示に依存していた。issue #652 で `permissionMode: plan` を試したが
#      書き込み系 Bash を止められないことを実機確認済み（docs/agents/tooling-decisions.md）。
#      本スクリプトは .claude/settings.json の PreToolUse（matcher: Bash）から呼ばれ、hook 入力の
#      `agent_type` が読み取り専用ロールのときだけ、**許可リストに無いコマンドを deny する**
#      （安全と証明されない限り拒否。check-direct-ddl-execution.sh と同じ設計）。
#
#      なぜ agent 定義の frontmatter `hooks:` ではなく settings.json に置くか（2026-09-05 実測）:
#      frontmatter hooks を 8 ロールに付けて sweep-ui を Agent tool（Claude Code 2.1.258、
#      デスクトップアプリ）で起動し mkdir / リダイレクト / sed -i を実行させたところ、
#      **すべて素通りした**（transcript に本スクリプトの痕跡なし、実体ファイルも作成された）。
#      公式仕様には「project subagent の frontmatter hooks は workspace trust 承認まで
#      スキップされる」とあるが、このフォルダは ~/.claude.json 上 trust 済みだったため
#      原因は未特定（このセッションの debug log は存在せず追えなかった）。原因が何であれ
#      「設定したのに黙って効かない」経路は採用できないので、公式に「サブエージェント内でも
#      発火し、入力に agent_id / agent_type が入る」と明記されている settings.json 側の
#      PreToolUse に置き、agent_type で対象ロールを判定する。メインセッション・書き込み
#      ロール（implementer 等）では agent_type が一致せず何もしない。
#
# 判定: コマンドを実行単位のセグメント（; & | 改行 ` $( で区切る）に分割し、各セグメントの
#       先頭コマンドが読み取り専用の許可リストにあることを要求する。加えて
#       - ファイルへのリダイレクト（> >>）は deny。/dev/null と 2>&1 だけ許可
#       - sed は -i / --in-place があれば deny
#       - git は読み取り系サブコマンドのみ許可
#       - npm / npx はテスト・lint・型検査の起動のみ許可
#       - bash / sh は scripts/ 配下のスクリプト起動のみ許可（進捗記録 log-agent-progress.sh 等は
#         読み取り専用ロールでも呼ぶ必要がある。scripts/ 配下は git 管理下でレビュー済みとみなす）
#       一致しないものは全て deny（未知のコマンドを許すと抜け道になる）。
#
# 見つけられること: 典型的な書き込み手段（上記）
# 誤って拒否するもの（既知。安全側なので残している）: **引用符の中の改行**。分割は引用符を見ないので、
#                     複数行の文字列（例: 複数行の grep パターン）の 2 行目以降を別のコマンドと読んで拒否する。
#                     2026-09-20 の実行でも数件出た（'repositoryError"' などが「許可されないコマンド」になる）。
#                     行の継続（バックスラッシュ + 改行）だけは issue #807 で直した。引用符まで解析するのは、
#                     見分けを誤ったときに抜け道になるので、見送っている
# 見つけられないこと: 許可コマンドの副作用（例: 許可した scripts/*.sh 自体が書き込む）。
#                     難読化（base64 経由等）は対象外。この hook は「うっかり」を止めるもので、
#                     悪意ある回避を防ぐものではない
#
# 対象ツール: Bash のみ。他のツール（Read/Grep/Glob）はそもそも書き込めない。
#             Write/Edit は frontmatter の tools で与えていない。
# 対象ロール: READONLY_AGENT_TYPES（空白区切り。既定は下記。テスト用に環境変数で差し替え可）
# jq 不在時は fail-closed（deny）。

command -v jq >/dev/null 2>&1 || { echo "jq not found: check-readonly-bash.sh cannot run" >&2; exit 2; }

# 対象ロールの優先順: 環境変数 READONLY_AGENT_TYPES → aidd.config.json の readonlyAgentTypes
# （issue #420 v1 セット B2。ロール名はエージェント構成に依存する固有値なので設定ファイルへ）
# → 既定（設定が無い環境でも従来どおり動く）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/aidd-config.sh" ]; then
  source "$SCRIPT_DIR/lib/aidd-config.sh"
else
  aidd_config_query() { printf '%s' "${2:-}"; }
fi
DEFAULT_READONLY_AGENT_TYPES='sweep-ui sweep-data sweep-db sweep-types reviewer completeness-critic adversarial-verify judge-panel'
CONFIG_READONLY_AGENT_TYPES="$(aidd_config_query '.readonlyAgentTypes // [] | join(" ")' '')"
READONLY_AGENT_TYPES="${READONLY_AGENT_TYPES:-${CONFIG_READONLY_AGENT_TYPES:-$DEFAULT_READONLY_AGENT_TYPES}}"
READONLY_CMDS='cat head tail less more grep egrep fgrep rg find ls wc awk cut sort uniq tr diff stat file jq echo printf true false test [ which type man env printenv pwd cd basename dirname realpath readlink date tree du df column comm paste fold nl od xxd strings shasum sha256sum md5sum md5 sed'
GIT_READONLY_SUBCMDS='status log diff show ls-files rev-parse grep blame branch describe cat-file rev-list shortlog remote tag worktree check-ignore ls-tree name-rev merge-base'

# 行の継続（バックスラッシュ + 改行）を、bash の実際の意味どおり 1 行につなぐ（issue #807）。
#
# WHY: 改行を常にコマンドの区切りとして切っていたので、複数行に書いたコマンドの 2 行目以降
#      （例: `--loop developer`）を「許可されないコマンド」として拒否していた。2026-09-20 の deep 実行で、
#      loop-observability の記録を呼んだ 12 体のうち 5 体がこれで拒否され、gap check には記録漏れと出た。
#      エージェントが記録を忘れたのではなく、止める仕組みが正しい呼び出しを止めていた。
#
# WHY(つなぐ条件を絞る): これは止める仕組みなので、つなぎ方を間違えると抜け道になる。
#      **bash が本当に継続として扱う場合だけ**つなぎ、迷う形は従来どおり分割する（＝拒否側に倒す）:
#      - 行末のバックスラッシュが**奇数個**のときだけ継続。偶数個（`\\`）はエスケープされたバックスラッシュで、
#        そのあとの改行は本物の区切り。素朴につなぐと次の行の rm が引数に化けて通る
#      - その行に `#` があればつながない。コメントの中のバックスラッシュ + 改行は継続にならないので、
#        つなぐと次の行のコマンドがコメントに隠れて通る（引用符の中の # まで見分ける解析はしない。
#        見分けを誤るより、つながずに拒否するほうが安全）
#      つないだ結果は 1 つのセグメントとして従来の検査（先頭コマンド・リダイレクト・区切り）を通る
join_line_continuations() {
  local input="$1" out="" line trailing rest
  while IFS= read -r line || [ -n "$line" ]; do
    rest="$line"
    trailing=0
    while [ "${rest%\\}" != "$rest" ]; do
      rest="${rest%\\}"
      trailing=$((trailing + 1))
    done
    if [ $((trailing % 2)) -eq 1 ] && [[ "$line" != *"#"* ]]; then
      # 継続: 末尾のバックスラッシュ 1 つを落とし、次の行と空白でつなぐ
      out="${out}${line%\\} "
    else
      out="${out}${line}"$'\n'
    fi
  done <<<"$input"
  printf '%s' "$out"
}

split_segments() {
  # 2>&1 / >&2 / &>/dev/null のような fd 複製は & で分割すると "1" が独立セグメントになるため
  # 先に除去する（リダイレクトの妥当性は呼び出し側で別途検査済み）
  join_line_continuations "$1" | sed -E 's/[0-9]?>&[0-9]//g; s/&>[^[:space:]]*//g' | tr ';&|`\n' $'\n\n\n\n\n' | sed 's/\$(/\n/g'
}

# 先頭の環境変数代入（FOO=bar CMD）を取り除く
strip_env_assignments() {
  local seg="$1"
  while [[ "$seg" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.*)$ ]]; do
    seg="${BASH_REMATCH[1]}"
  done
  printf '%s' "$seg"
}

deny() {
  jq -n --arg reason "$1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
  exit 0
}

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
[ "$TOOL_NAME" = "Bash" ] || exit 0
AGENT_TYPE="$(printf '%s' "$INPUT" | jq -r '.agent_type // ""')"
[ -n "$AGENT_TYPE" ] || exit 0
IS_READONLY_ROLE=0
for t in $READONLY_AGENT_TYPES; do
  [ "$AGENT_TYPE" = "$t" ] && IS_READONLY_ROLE=1
done
[ "$IS_READONLY_ROLE" -eq 1 ] || exit 0
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
[ -n "$COMMAND" ] || exit 0

# リダイレクト: > または >> のうち、/dev/null 宛てと 2>&1 以外は deny
REDIRECTS="$(printf '%s' "$COMMAND" | grep -oE '[0-9]?>>?[[:space:]]*[^[:space:]]*' || true)"
if [ -n "$REDIRECTS" ]; then
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    case "$r" in
      *'>&1'|*'>&2'|*'/dev/null') ;;
      *) deny "読み取り専用ロールではファイルへのリダイレクト（${r}）は許可されません（issue #713）。結果は標準出力に出してください。" ;;
    esac
  done <<< "$REDIRECTS"
fi

SEGMENTS="$(split_segments "$COMMAND")"
while IFS= read -r RAW_SEG; do
  SEG="$(printf '%s' "$RAW_SEG" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -z "$SEG" ] && continue
  SEG="$(strip_env_assignments "$SEG")"
  [ -z "$SEG" ] && continue
  FIRST="$(printf '%s' "$SEG" | awk '{print $1}')"
  SECOND="$(printf '%s' "$SEG" | awk '{print $2}')"
  # scripts/ 配下のスクリプト直接起動（scripts/log-agent-progress.sh 等）は basename 化の前に判定する
  case "$FIRST" in
    scripts/*.sh|./scripts/*.sh|*/scripts/*.sh) continue ;;
  esac
  # パス前置（/usr/bin/grep 等）は basename で比較
  FIRST_BASE="${FIRST##*/}"

  case "$FIRST_BASE" in
    sed)
      # -i / -i.bak / -i'' / -Ei / --in-place / --in-place=.bak をすべて拾う
      if [[ "$SEG" =~ (^|[[:space:]])(-[a-zA-Z]*i[^[:space:]]*|--in-place[^[:space:]]*) ]]; then
        deny "読み取り専用ロールでは sed -i（インプレース編集）は許可されません（issue #713）: $SEG"
      fi
      continue
      ;;
    git)
      for sub in $GIT_READONLY_SUBCMDS; do
        [ "$SECOND" = "$sub" ] && continue 2
      done
      deny "読み取り専用ロールでは git $SECOND は許可されません（許可: ${GIT_READONLY_SUBCMDS}）（issue #713）"
      ;;
    npm)
      case "$SEG" in
        npm\ test*|npm\ run\ test*|npm\ run\ lint*|npm\ run\ typecheck*|npm\ ls*|npm\ view*|npm\ explain*|npm\ --version*|npm\ -v*) continue ;;
        *) deny "読み取り専用ロールでは npm はテスト・lint・型検査の起動のみ許可されます（issue #713）: $SEG" ;;
      esac
      ;;
    npx)
      case "$SECOND" in
        tsc|vitest|eslint|prettier) continue ;;
        *) deny "読み取り専用ロールでは npx $SECOND は許可されません（許可: tsc vitest eslint prettier）（issue #713）" ;;
      esac
      ;;
    bash|sh)
      case "$SECOND" in
        scripts/*|./scripts/*|*/scripts/*) continue ;;
        *) deny "読み取り専用ロールでは bash/sh は scripts/ 配下のスクリプト起動のみ許可されます（issue #713）: $SEG" ;;
      esac
      ;;
  esac

  for cmd in $READONLY_CMDS; do
    [ "$FIRST_BASE" = "$cmd" ] && continue 2
  done
  deny "読み取り専用ロール（${AGENT_TYPE}）では '$FIRST_BASE' は許可されません（issue #713）。許可リスト: $READONLY_CMDS / git <読み取り系> / npm test|run lint|run typecheck / npx tsc|vitest|eslint / bash scripts/*.sh。書き込みが必要なら status: blocked で親に報告してください。"
done <<< "$SEGMENTS"

exit 0
