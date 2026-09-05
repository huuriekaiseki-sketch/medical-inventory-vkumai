#!/usr/bin/env bash
set -euo pipefail

# WHY: SessionStart hookから呼ばれる。CLAUDE.md / docs/agents/common.md
# （@importでCLAUDE.mdに実質連結される正本）は毎メッセージのプリロードとして
# 課金対象になるため、肥大化に気づかず膨張し続けるリスクがある。
# ただしこのリポジトリのcommon.mdは意図的に構造化されたAIDDフレームワークの
# 機械検知ルール集であり、「短ければ良い」わけではない（削除の判断は人間に委ねる）。
# block（session開始そのものの停止）はできない前提のためwarningのみ。
#
# 2つの検査を行う:
#  (a) 行数（従来）: CLAUDE.md=200行、common.md=300行が既定。公式推奨「1ファイル200行以下」に
#      対し、common.mdは@importで別ファイルに分離されている実態を踏まえ緩めにしている
#  (b) 常時ロード総量（issue #711）: 公式仕様では @import 先は起動時に全量ロードされ
#      「分割してもコンテキストは減らない」。また .claude/rules/ のうち paths: frontmatter の
#      無いルールも毎セッションロードされる。行数だけ見ていると、@import先やrulesに
#      移した分が計測から漏れるため、CLAUDE.md + @import（4段まで再帰）+ unscoped rules の
#      合計**文字数**で閾値判定する。バイト数は日本語1文字3バイトでトークンの指標に
#      ならないため使わない（issue #716と同じ理由）。トークン概算は
#      「非ASCII 1文字≈1トークン、ASCII 4文字≈1トークン」で出す（実測に基づく近似。
#      2026-09-05: 本体21,791文字≈9,200トークン。根拠は docs/agents/decisions/aidd-pipeline.md）。
#      閾値の既定 24,000 文字は 2026-09-05 実測値の約 +10%（「増えたら気づく」ラチェット）。
#      MEMORY.md（auto memory、先頭200行/25KB）と SessionStart hook の出力は、hook自身から
#      安全に測れない（前者は $HOME 配下の個人ファイル、後者は自己再帰）ため対象外。
#      それらを含めた実測値は issue #711 のコメントを参照。
#
# 閾値は環境変数で上書き可能:
#   CLAUDE_MD_LINE_LIMIT（既定200）/ COMMON_MD_LINE_LIMIT（既定300）
#   STARTUP_CONTEXT_CHAR_LIMIT（既定24000）
#   CLAUDE_PROJECT_DIR（既定 pwd。テスト用差し替え）

command -v wc >/dev/null 2>&1 || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CLAUDE_MD_LIMIT="${CLAUDE_MD_LINE_LIMIT:-200}"
COMMON_MD_LIMIT="${COMMON_MD_LINE_LIMIT:-300}"
CHAR_LIMIT="${STARTUP_CONTEXT_CHAR_LIMIT:-24000}"

CLAUDE_MD_PATH="$PROJECT_DIR/CLAUDE.md"
COMMON_MD_PATH="$PROJECT_DIR/docs/agents/common.md"

WARNINGS=()

if [ -f "$CLAUDE_MD_PATH" ]; then
  LINES=$(wc -l < "$CLAUDE_MD_PATH" | tr -d ' ')
  if [ "$LINES" -gt "$CLAUDE_MD_LIMIT" ]; then
    WARNINGS+=("CLAUDE.mdが${LINES}行（閾値${CLAUDE_MD_LIMIT}行）を超えています。全メッセージでプリロードされるため、不要な記述が無いか見直しを検討してください。")
  fi
fi

if [ -f "$COMMON_MD_PATH" ]; then
  LINES=$(wc -l < "$COMMON_MD_PATH" | tr -d ' ')
  if [ "$LINES" -gt "$COMMON_MD_LIMIT" ]; then
    WARNINGS+=("docs/agents/common.mdが${LINES}行（閾値${COMMON_MD_LIMIT}行）を超えています。CLAUDE.mdへの@importで全メッセージにプリロードされるため、既存ルールの棚卸しファイルへの分離（issue #486と同様の対応）を検討してください。")
  fi
fi

# ---- (b) 常時ロード総量（jq が無ければこの検査だけ省略） ----
if command -v jq >/dev/null 2>&1 && [ -f "$CLAUDE_MD_PATH" ]; then
  # @import を再帰的に解決して対象ファイル一覧を作る（公式仕様: 相対パスは import 元ファイル基準、
  # 最大4段、コードスパン・フェンス内の @ は無視、~/ は $HOME 展開）
  declare -a FILES=()
  declare -a SEEN=()
  collect() {
    local file="$1" depth="$2" line target abs
    for s in "${SEEN[@]:-}"; do [ "$s" = "$file" ] && return 0; done
    SEEN+=("$file")
    FILES+=("$file")
    [ "$depth" -ge 4 ] && return 0
    local in_fence=0
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in '```'*|'~~~'*) in_fence=$((1 - in_fence)); continue ;; esac
      [ "$in_fence" -eq 1 ] && continue
      # コードスパンを潰してから @path を拾う
      line="$(printf '%s' "$line" | sed -E 's/`[^`]*`//g')"
      for target in $(printf '%s' "$line" | grep -oE '(^|[[:space:]])@[^[:space:]]+' | sed -E 's/^[[:space:]]*@//'); do
        case "$target" in
          '~/'*) abs="$HOME/${target#\~/}" ;;
          /*) abs="$target" ;;
          *) abs="$(dirname "$file")/$target" ;;
        esac
        if [ -f "$abs" ]; then collect "$abs" $((depth + 1)); fi
      done
    done < "$file"
    # 最後の [ -f ] が偽だと関数の戻り値が非0になり set -e で落ちるため明示的に 0 を返す
    return 0
  }
  collect "$CLAUDE_MD_PATH" 0 || true
  # paths: frontmatter の無い rules も起動時ロード
  if [ -d "$PROJECT_DIR/.claude/rules" ]; then
    while IFS= read -r rule; do
      [ -z "$rule" ] && continue
      if ! awk 'NR==1 && $0 != "---" {exit 1} /^---$/ && NR>1 {exit 0} /^paths:/ {found=1} END {exit found ? 0 : 1}' "$rule" 2>/dev/null; then
        FILES+=("$rule")
      fi
    done < <(find "$PROJECT_DIR/.claude/rules" -name '*.md' -type f 2>/dev/null | sort)
  fi

  TOTAL_CHARS=0
  TOTAL_NONASCII=0
  BREAKDOWN=""
  for f in "${FILES[@]}"; do
    chars="$(jq -Rs 'length' "$f")"
    nonascii="$(jq -Rs '[explode[] | select(. > 127)] | length' "$f")"
    TOTAL_CHARS=$((TOTAL_CHARS + chars))
    TOTAL_NONASCII=$((TOTAL_NONASCII + nonascii))
    BREAKDOWN="${BREAKDOWN}
  - ${f#"$PROJECT_DIR"/}: ${chars}文字"
  done
  ASCII=$((TOTAL_CHARS - TOTAL_NONASCII))
  EST_TOKENS=$((TOTAL_NONASCII + ASCII / 4))

  if [ "$TOTAL_CHARS" -gt "$CHAR_LIMIT" ]; then
    WARNINGS+=("常時ロードされる指示ファイルの合計が${TOTAL_CHARS}文字（閾値${CHAR_LIMIT}文字、概算${EST_TOKENS}トークン）を超えています（issue #711）。@importで分割してもコンテキストは減りません。フロー実行時にしか要らない手順はskill化、特定パスでしか要らない規則はpaths付きrulesへ移すことを検討してください。内訳:${BREAKDOWN}")
  fi
fi

if [ "${#WARNINGS[@]}" -eq 0 ]; then
  exit 0
fi

MSG=$(printf '%s\n' "${WARNINGS[@]}")

if command -v jq >/dev/null 2>&1; then
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $msg
    }
  }'
else
  echo "$MSG" >&2
fi
