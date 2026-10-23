#!/usr/bin/env bash
set -euo pipefail

# SessionStart hook（startup 群）から呼ばれる。issue #743。
#
# なぜ: Claude Code 2.1.257 で追加された環境変数 CLAUDE_CODE_SUBAGENT_MODEL_FORCE は、
# 全 subagent に同じモデルを強制する。このリポジトリの AIDD は agent ごとに model / effort を
# 分けてコストと精度を配分している（sweep=haiku / adversarial=opus 等。issue #419・#693）
# ので、この変数が個人のシェル設定や settings の env に残っていると、その階層が
# **黙って**無効化される（Workflow の agent() 呼び出しの model 指定が上書きされる）。
# 結果は「eval が理由不明に悪化する」「コストが理由不明に増減する」として現れるため、
# 起点で気づける形の検知を置く。
#
# 検知対象の変数は 2 つ。それぞれ独立に検知し、両方あれば 1 件の systemMessage に
# 両方を名指しする:
#   - CLAUDE_CODE_SUBAGENT_MODEL_FORCE     全 subagent に同じモデルを強制する（2.1.257）
#   - CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL  Workflow の agent だけを 1 つのモデルに寄せる。
#     他の subagent は各自のモデルのまま（2.1.296。2026-10-23 の公式 docs 差分確認で判明）。
#     影響範囲が Workflow に限られるだけで、AIDD の階層は Workflow の agent() で効かせて
#     いるため、FORCE と同じく黙って無効化される
#
# warning-only の理由: 環境変数は個人環境の設定であり、リポジトリ側から消せない。
# 意図的に使う場面（全 subagent を haiku にして安価に素振りする等）もあるため、
# 止めずに「階層が無効化されている」事実だけ伝え、判断は人に委ねる。
#
# 検知源は 2 つ:
#   1. 現在のプロセス環境（hook は claude 本体の環境を継承する）
#   2. settings ファイルの `env` ブロック（settings.json / settings.local.json / 個人設定）。
#      本体が env を適用したあとに hook が起動するなら 1 で拾えるが、適用順の仕様に
#      依存しないよう、ファイル側も直接見る
#
# テスト用の注入ポイント:
#   SUBAGENT_MODEL_FORCE_SETTINGS_PATHS  検査する settings ファイルのパス（コロン区切り。
#                                        既定は project / local / $HOME の 3 つ）

FORCE_VAR="CLAUDE_CODE_SUBAGENT_MODEL_FORCE"
WORKFLOW_VAR="CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
DEFAULT_PATHS="$PROJECT_DIR/.claude/settings.json:$PROJECT_DIR/.claude/settings.local.json:$HOME/.claude/settings.json"
SETTINGS_PATHS="${SUBAGENT_MODEL_FORCE_SETTINGS_PATHS:-$DEFAULT_PATHS}"

FOUND_VALUE=""
FOUND_SOURCE=""

# find_var <変数名>: 見つかれば FOUND_VALUE / FOUND_SOURCE を設定する（見つからなければ空）。
# 環境変数を settings より優先し、settings は先に見つかったファイルを採る
find_var() {
  local name="$1" p v
  FOUND_VALUE=""
  FOUND_SOURCE=""

  # 1. プロセス環境。空文字は「未設定」と同じ扱い（Claude Code 側も空なら強制しない）
  if [ -n "${!name:-}" ]; then
    FOUND_VALUE="${!name}"
    FOUND_SOURCE="環境変数"
    return 0
  fi

  # 2. settings の env ブロック。jq が無い・ファイルが壊れている場合は fail-open で沈黙する
  #    （この hook の目的は「気づく」ことで、壊れた JSON の指摘は別の検査の仕事）
  command -v jq >/dev/null 2>&1 || return 0
  local paths
  IFS=':' read -r -a paths <<< "$SETTINGS_PATHS"
  for p in "${paths[@]}"; do
    [ -f "$p" ] || continue
    v="$(jq -r --arg k "$name" '.env[$k] // empty' "$p" 2>/dev/null || true)"
    if [ -n "$v" ]; then
      FOUND_VALUE="$v"
      FOUND_SOURCE="$p の env"
      return 0
    fi
  done
  return 0
}

MSG=""

find_var "$FORCE_VAR"
if [ -n "$FOUND_VALUE" ]; then
  MSG="${FORCE_VAR}=${FOUND_VALUE} が設定されています（検知元: ${FOUND_SOURCE}）。この変数は全 subagent のモデルを強制するため、AIDD のモデル階層（sweep=haiku / adversarial=opus など、Workflow の agent() ごとの model 指定。issue #419・#693）が無効化され、eval の精度とコストが設計値から黙ってずれます。意図した設定でなければ unset するか settings の env から削除してください（warning のみ、issue #743）。"
fi

find_var "$WORKFLOW_VAR"
if [ -n "$FOUND_VALUE" ]; then
  WF_MSG="${WORKFLOW_VAR}=${FOUND_VALUE} が設定されています（検知元: ${FOUND_SOURCE}）。この変数は Workflow の agent だけを 1 つのモデルに寄せる（他の subagent は各自のモデルのまま。Claude Code 2.1.296）ため、AIDD のモデル階層（sweep=haiku / adversarial=opus など、Workflow の agent() ごとの model 指定。issue #419・#693）が無効化され、eval の精度とコストが設計値から黙ってずれます。意図した設定でなければ unset するか settings の env から削除してください（warning のみ、issue #743 の延長）。"
  if [ -n "$MSG" ]; then
    MSG="${MSG}"$'\n'"${WF_MSG}"
  else
    MSG="$WF_MSG"
  fi
fi

[ -n "$MSG" ] || exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
