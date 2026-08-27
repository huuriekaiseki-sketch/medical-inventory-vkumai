#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #524（#444「hook拡張第2弾」の後続、issue #495と同型のStop hook）。
# docs/agents/common.md「引き継ぎフォーマット」の実施（PR本文・セッション終了報告・
# docs/sessions/への記録のいずれかに30秒サマリー・00〜05の証拠・後任AIへの注意を
# 残すこと）は、「検知手段のないルールの棚卸し」表の第3層ルールだった
# （自然言語指示のみに依存し、破られても機械的に気づけなかった）。
# このスクリプトはStop hookとして毎ターン終了時に発火し、このセッションで
# `gh pr create`/`gh pr edit`の形跡があるのに、対応するPRの本文に必須見出しが無い場合に
# systemMessageで警告する（block不可・warningのみ）。
#
# 検知ロジック:
# 1. transcript_pathを軽くgrepし、このセッションで`gh pr create`/`gh pr edit`が呼ばれた
#    形跡があるかを確認する。無ければ「PR操作なしセッション」として沈黙する
#    （最頻経路。gh呼び出し自体を避けてコストを抑える）
# 2. 形跡があれば、現在のブランチに紐づく直近のPR（`gh pr list --head <branch>`）を取得する
# 3. PR本文に「30秒サマリー」「どう確認したか」の2見出しが含まれるかを確認する
#    （issue #666でフォーマットを00〜05構成に刷新した際、最も本質的な2つに絞った近似判定。
#    厳密なMarkdown見出しレベル一致ではなく部分文字列一致で緩く判定する。
#    誤検知よりも取りこぼしを許容する）
# 4. 揃っていなければ警告する
#
# 設計方針:
# - fail-open: 判定材料が取れないケース（gh/jq不在・git repo外・ネットワーク不通・
#   PR未検出等）はすべて沈黙する
# - 警告は同一セッション・同一PR番号につき1回のみ
# - 全経路 exit 0（blockしない）
#
# 既知の限界:
# - セッション終了報告・docs/sessions/への記録のみで完結し、PRを一切作らない作業フローは
#   検知対象外（この警告はPR本文経由の引き継ぎのみをカバーする）
# - 見出し文言の部分文字列一致のため、別の文脈で偶然「30秒サマリー」「どう確認したか」という語が
#   PR本文に含まれていれば見出しが無くても素通りしうる（fail-openの範囲内として許容）
#
# 環境変数（テスト用の注入ポイント）:
#   HANDOFF_CHECK_SESSION_ID       hook stdinのsession_idの代替
#   HANDOFF_CHECK_TRANSCRIPT_PATH  hook stdinのtranscript_pathの代替
#   HANDOFF_CHECK_MARKER_FILE      警告済みマーカー（既定 .aidd/handoff-format-warning-shown.json）
#   HANDOFF_CHECK_GH_CMD           `gh`コマンドの代替（テスト用フェイク）
#   HANDOFF_CHECK_GIT_BRANCH       現在ブランチの代替

cd "$(dirname "$0")/.."

MARKER_FILE="${HANDOFF_CHECK_MARKER_FILE:-.aidd/handoff-format-warning-shown.json}"
GH_CMD="${HANDOFF_CHECK_GH_CMD:-gh}"

command -v jq >/dev/null 2>&1 || exit 0
command -v "$GH_CMD" >/dev/null 2>&1 || exit 0

HOOK_INPUT=""
if [ -z "${HANDOFF_CHECK_SESSION_ID:-}" ] || [ -z "${HANDOFF_CHECK_TRANSCRIPT_PATH:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi
SESSION_ID="${HANDOFF_CHECK_SESSION_ID:-$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)}"
TRANSCRIPT_PATH="${HANDOFF_CHECK_TRANSCRIPT_PATH:-$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)}"

[ -n "$SESSION_ID" ] || exit 0
[ -n "$TRANSCRIPT_PATH" ] || exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# 1. PR作成/更新の形跡が無ければ沈黙（最頻経路。gh呼び出し自体を避ける）
if ! grep -qF -e '"command":"gh pr create' -e '"command":"gh pr edit' "$TRANSCRIPT_PATH" 2>/dev/null; then
  exit 0
fi

# 2. 現在のブランチに紐づく直近PRを取得
BRANCH="${HANDOFF_CHECK_GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
[ -n "$BRANCH" ] || exit 0

PR_JSON="$("$GH_CMD" pr list --head "$BRANCH" --state all --json number,body --limit 1 2>/dev/null || true)"
[ -n "$PR_JSON" ] || exit 0

PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.[0].number // empty' 2>/dev/null || true)"
PR_BODY="$(printf '%s' "$PR_JSON" | jq -r '.[0].body // empty' 2>/dev/null || true)"
[ -n "$PR_NUMBER" ] || exit 0

# 警告済みマーカー: 同一セッション・同一PR番号では2回目以降沈黙
if [ -f "$MARKER_FILE" ]; then
  WARNED_KEY="$(jq -r '.key // empty' "$MARKER_FILE" 2>/dev/null || true)"
  if [ "$WARNED_KEY" = "${SESSION_ID}:${PR_NUMBER}" ]; then
    exit 0
  fi
fi

HAS_SUMMARY=0
if printf '%s' "$PR_BODY" | grep -qF '30秒サマリー'; then
  HAS_SUMMARY=1
fi
HAS_VERIFIED=0
if printf '%s' "$PR_BODY" | grep -qF 'どう確認したか'; then
  HAS_VERIFIED=1
fi

if [ "$HAS_SUMMARY" -eq 1 ] && [ "$HAS_VERIFIED" -eq 1 ]; then
  exit 0
fi

write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.handoff-format-warning.XXXXXX" 2>/dev/null)" || return 1
  jq -n --arg key "${SESSION_ID}:${PR_NUMBER}" '{key: $key}' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

MSG="PR #${PR_NUMBER} の本文に、docs/agents/common.md「引き継ぎフォーマット」の必須見出し（30秒サマリー / どう確認したか）が見当たりません。作業完了報告には引き継ぎフォーマット（30秒サマリー・00〜05の証拠・後任AIへの注意）を含めてください（この警告はこのPRにつき1回のみ表示されます）。"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
