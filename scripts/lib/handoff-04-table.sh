# 引き継ぎメモの「04 どう確認したか」の表を判定する（唯一の入口）。
#
# WHY(2026-09-11 に切り出した): この判定は PR 本文（Stop hook）と `docs/sessions/` の
#      メモ（構造テスト）の**両方**が要る。片方へ複製すると、4 値の語彙や理由の扱いを
#      直したときに**もう片方だけが古いまま**になる——今日 5 回踏んだ C-047 の形そのもの。
#      だから判定は 1 か所に置き、両方がここを呼ぶ。
#
# 使い方:
#   source "$SCRIPT_DIR/lib/handoff-04-table.sh"
#   issues="$(handoff_four_state_issues "$body")"   # 空なら問題なし
#
# 限界:
#   - 「どう確認したか」の見出しから次の `## ` までを表とみなす近似。
#     節の中に別の表があると、その行も 04 表として読む。
#   - 状態は**先頭の 1 文字で**見る（`✅ 実施（手動）` のような後ろの語は見ない）。

# table-row.sh（`\|` を区切りとして数えない割り方）を先に読む。
# 04 表の証跡列にはコマンドを書くので、`a \| b` は実際に出うる
# shellcheck source=table-row.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/table-row.sh"

# $1=メモ本文 → 4 値から外れた行を "種別（理由）; " の形で並べて返す（空なら問題なし）
handoff_four_state_issues() {
  local body="$1" out
  out="$(printf '%s\n' "$body" | table_mask_stream | awk -F'|' '
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
  # 退避した文字は人に見せる前に戻す
  printf '%s' "${out//$TABLE_ROW_SENTINEL/\\|}"
}
