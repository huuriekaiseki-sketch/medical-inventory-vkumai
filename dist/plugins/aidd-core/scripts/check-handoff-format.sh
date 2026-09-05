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
# 2. 形跡があれば、対象 PR 番号を transcript から特定する
#    （`gh pr create` の tool_result に残る PR URL の /pull/N と、`gh pr edit N` のコマンド文字列。
#    scripts/lib/pr-numbers-from-transcript.jq）。1 件も取れなければ従来どおり現在ブランチの
#    直近 PR（`gh pr list --head <branch>`）にフォールバックする
#    WHY(2026-09-05): 以前は現在ブランチだけを見ていたが、PR を作って CI を待ち、マージして main へ
#    戻った後の Stop ではブランチが main になり PR が見つからず沈黙していた。1 セッションで 14 本の
#    PR を作ったのに 1 本も評価されなかったことを実データで確認した（fail-open の無音死）
# 3. 各 PR の本文に「30秒サマリー」「どう確認したか」の2見出しが含まれるかを確認する
#    （issue #666でフォーマットを00〜05構成に刷新した際、最も本質的な2つに絞った近似判定。
#    厳密なMarkdown見出しレベル一致ではなく部分文字列一致で緩く判定する。
#    誤検知よりも取りこぼしを許容する）
# 4. 揃っていなければ警告する
#
# 設計方針:
# - fail-open: 判定材料が取れないケース（gh/jq不在・git repo外・ネットワーク不通・
#   PR未検出等）はすべて沈黙する
# - 警告は同一セッション・同一PR番号につき1回のみ（マーカーは keys 配列で複数 PR を保持）
# - 全経路 exit 0（blockしない）
#
# 5. （PR②、docs/superpowers/specs/2026-09-04-derive-test-selection-design.md）見出しが揃って
#    いれば、「どう確認したか」節の表行の状態列が4値（✅ / ➖ / 🟡 / ⬜）で始まるか、
#    ➖ / ⬜ の行に理由（3列目）があるかを見る。外れた行を名指しで警告する（block しない。
#    block すると書く側が行を削って合図が消える。列ずれ・4値外は「フォーマットに収まらない
#    約束が出た」合図として人が見る）
#
# 6. （2026-09-04、docs/agents/known-failure-patterns.md「依存関係層」）PR の変更ファイルに
#    package.json / package-lock.json が含まれるのに、本文に「依存の変更」の記述が無ければ警告する。
#    依存追加は第三者コードを増やす設計判断であり、用途・代替案・影響・監査結果を本文に残す
#    （`gh pr view --json files` で変更ファイルを取る。取れなければ沈黙 = fail-open）
#
# 既知の限界:
# - セッション終了報告・docs/sessions/への記録のみで完結し、PRを一切作らない作業フローは
#   検知対象外（この警告はPR本文経由の引き継ぎのみをカバーする）
# - 4値検知は「どう確認したか」を含む見出し行から次の "## " 見出しまでの "| " で始まる行だけを
#   見る近似。表を使わず箇条書きで書いた04（バグ修正時の代替形式）は検査しない
# - 見出し文言の部分文字列一致のため、別の文脈で偶然「30秒サマリー」「どう確認したか」という語が
#   PR本文に含まれていれば見出しが無くても素通りしうる（fail-openの範囲内として許容）
# - transcript からの PR 番号抽出は `gh pr create` の tool_result に PR URL が出ることに依存する
#   （gh の出力仕様）。URL が出ない場合はブランチのフォールバックに落ちる
#
# 環境変数（テスト用の注入ポイント）:
#   HANDOFF_CHECK_SESSION_ID       hook stdinのsession_idの代替
#   HANDOFF_CHECK_TRANSCRIPT_PATH  hook stdinのtranscript_pathの代替
#   HANDOFF_CHECK_MARKER_FILE      警告済みマーカー（既定 .aidd/handoff-format-warning-shown.json）
#   HANDOFF_CHECK_GH_CMD           `gh`コマンドの代替（テスト用フェイク）
#   HANDOFF_CHECK_GIT_BRANCH       現在ブランチの代替

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# 2. 対象 PR 番号の特定。transcript 由来を優先し、取れなければ現在ブランチにフォールバック
PR_NUMBERS="$(jq -s -r -f "$SCRIPT_DIR/lib/pr-numbers-from-transcript.jq" "$TRANSCRIPT_PATH" 2>/dev/null || true)"
if [ -z "$PR_NUMBERS" ]; then
  BRANCH="${HANDOFF_CHECK_GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
  [ -n "$BRANCH" ] || exit 0
  PR_JSON="$("$GH_CMD" pr list --head "$BRANCH" --state all --json number,body --limit 1 2>/dev/null || true)"
  [ -n "$PR_JSON" ] || exit 0
  PR_NUMBERS="$(printf '%s' "$PR_JSON" | jq -r '.[0].number // empty' 2>/dev/null || true)"
fi
[ -n "$PR_NUMBERS" ] || exit 0

# 警告済みマーカー（同一セッション・同一PR番号では2回目以降沈黙）。
# 旧形式 {key: "..."} と新形式 {keys: ["...", ...]} の両方を読む
WARNED_KEYS=""
if [ -f "$MARKER_FILE" ]; then
  WARNED_KEYS="$(jq -r '((.keys // []) + [.key // empty]) | .[]' "$MARKER_FILE" 2>/dev/null || true)"
fi

# 1 PR 分の判定。警告文を stdout に出す（問題なければ何も出さない）
check_pr() {
  local pr_number="$1"
  local pr_body has_summary has_verified four_state_issues dep_issue pr_files
  pr_body="$("$GH_CMD" pr view "$pr_number" --json body --jq '.body' 2>/dev/null || true)"

  has_summary=0
  if printf '%s' "$pr_body" | grep -qF '30秒サマリー'; then
    has_summary=1
  fi
  has_verified=0
  if printf '%s' "$pr_body" | grep -qF 'どう確認したか'; then
    has_verified=1
  fi

  # 04 表の4値検知。「どう確認したか」節の表行（見出し行・区切り行を除く）ごとに
  # 状態列（2列目）が4値のいずれかで始まるか、➖ / ⬜ の行に3列目（理由）があるかを見る。
  # 外れた行の種別名を four_state_issues に溜める（空なら問題なし）
  four_state_issues=""
  if [ "$has_verified" -eq 1 ]; then
    four_state_issues="$(printf '%s\n' "$pr_body" | awk -F'|' '
      /^#+ .*どう確認したか/ {f=1; next}
      /^## / {f=0}
      f && /^\| / {
        kind=$2; gsub(/^ +| +$/,"",kind)
        if (kind=="" || kind ~ /^-+$/ || kind ~ /^種別/) next
        status=$3; gsub(/^ +| +$/,"",status)
        reason=$4; gsub(/^ +| +$/,"",reason)
        if (status !~ /^(✅|➖|🟡|⬜)/) { printf "%s（状態 \"%s\" が4値でない）; ", kind, status; next }
        # substr は Linux の awk（C ロケール）だとバイト単位で絵文字を切るため使わない
        if (status ~ /^(➖|⬜)/ && (reason=="" || reason=="—")) { mark = (status ~ /^➖/) ? "➖" : "⬜"; printf "%s（%s なのに理由が無い）; ", kind, mark }
      }' 2>/dev/null || true)"
  fi

  # 依存の変更（package.json / package-lock.json を触った PR に「依存の変更」の記述があるか）。
  # 変更ファイル一覧が取れない場合は判定しない（fail-open）
  dep_issue=""
  pr_files="$("$GH_CMD" pr view "$pr_number" --json files --jq '.files[].path' 2>/dev/null || true)"
  if printf '%s\n' "$pr_files" | grep -qxE '(.*/)?package(-lock)?\.json'; then
    if ! printf '%s' "$pr_body" | grep -qF '依存の変更'; then
      dep_issue="$(printf '%s\n' "$pr_files" | grep -E '(.*/)?package(-lock)?\.json' | tr '\n' ' ')"
    fi
  fi

  if [ "$has_summary" -eq 1 ] && [ "$has_verified" -eq 1 ] && [ -z "$four_state_issues" ] && [ -z "$dep_issue" ]; then
    return 0
  fi

  if [ "$has_summary" -eq 1 ] && [ "$has_verified" -eq 1 ] && [ -z "$four_state_issues" ]; then
    printf '%s' "PR #${pr_number} は依存関係ファイル（${dep_issue}）を変更していますが、本文に「依存の変更」の記述がありません。追加・更新・削除したパッケージごとに、用途 / 代替案 / 権限・環境変数・DB への影響 / 固定した版と出所 / クリーンインストールと既知脆弱性の監査の結果（このリポジトリでは aidd.config.json の commands と docs/agents/common.md「依存関係の変更ルール」を参照） / ロールバック方法を 00 欄「依存の変更」に書いてください（依存追加は第三者コードを増やす設計判断。docs/agents/known-failure-patterns.md「依存関係層」。この警告はこのPRにつき1回のみ表示されます）。"
  elif [ "$has_summary" -eq 1 ] && [ "$has_verified" -eq 1 ]; then
    printf '%s' "PR #${pr_number} の「04 どう確認したか」に、4値（✅ 実施 / ➖ 今回不要 / 🟡 一部 / ⬜ 未実施）に収まらない行があります: ${four_state_issues}。フォーマットに収まらない行は「書き方の問題」か「一覧（docs/agents/test-matrix.md）に無い種類の確認が出てきた」かのどちらかです。前者なら bash scripts/derive-test-selection.sh origin/main --format table の出力に揃え、後者なら一覧と derive ルールへの追加を検討してください（この警告はこのPRにつき1回のみ表示されます）。"
  else
    printf '%s' "PR #${pr_number} の本文に、docs/agents/common.md「引き継ぎフォーマット」の必須見出し（30秒サマリー / どう確認したか）が見当たりません。作業完了報告には引き継ぎフォーマット（30秒サマリー・00〜05の証拠・後任AIへの注意）を含めてください（この警告はこのPRにつき1回のみ表示されます）。"
  fi
}

MESSAGES=""
NEW_KEYS=""
while IFS= read -r pr_number; do
  [ -n "$pr_number" ] || continue
  key="${SESSION_ID}:${pr_number}"
  if printf '%s\n' "$WARNED_KEYS" | grep -qxF "$key"; then
    continue
  fi
  msg="$(check_pr "$pr_number")"
  [ -n "$msg" ] || continue
  MESSAGES="${MESSAGES:+$MESSAGES

}$msg"
  NEW_KEYS="${NEW_KEYS:+$NEW_KEYS
}$key"
done <<< "$PR_NUMBERS"

[ -n "$MESSAGES" ] || exit 0

# 警告した PR のキーをマーカーへ追記（atomic）。書けなくてもクラッシュせず警告は出す
write_marker() {
  local dir tmp
  dir="$(dirname "$MARKER_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.handoff-format-warning.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n%s\n' "$WARNED_KEYS" "$NEW_KEYS" \
    | jq -R -s 'split("\n") | map(select(length > 0)) | unique | {keys: .}' > "$tmp" 2>/dev/null \
    || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$MARKER_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}
set +e
write_marker
set -e

jq -n --arg msg "$MESSAGES" '{systemMessage: $msg}'

exit 0
