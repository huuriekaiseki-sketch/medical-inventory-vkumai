#!/bin/bash
# issue #446フォローアップ: subagentStatusLineでサブエージェント行にcontext使用率・
# token数を表示する。show-agent-status.sh（履歴側）を補完するリアルタイム表示。
#
# フィールドの型・挙動は2026-07-18に実機（通常のターミナルCLIでのインタラクティブ
# セッション、scripts/subagent-statusline-debug-collector.shで捕捉）で確認済み:
# - startTimeはUnix epochミリ秒（13桁）。本スクリプトでは未使用（elapsed計算はしない。
#   捕捉できたのはtoken推移のみで、経過時間表示の要否・単位は別途検討）
# - tasks[]の各要素にnameが無いケースがある（Task tool経由のlocal_agent型はlabel/
#   descriptionのみ）。フォールバックはlabel→name→description→type→"agent"の順
# - タスク完了時はstatusが"done"等に変わるのではなく、tasks配列から丸ごと消える。
#   そのため本スクリプトが完了状態のアイコンを描画する機会は実測では確認できていない
#   （running以外のstatus値は公式ドキュメントの一般的な語彙から類推してフォールバック
#   分岐のみ用意し、実機未確認のまま残す）
# - contextWindowSizeはモデル未解決時は省略される（公式ドキュメント記載どおり実測でも
#   確認、その場合は%表示を省く）
input=$(cat)

echo "$input" | jq -c '
  (.columns // 80) as $cols
  | (.tasks // [])[]
  | (.label // .name // .description // .type // "agent") as $label
  | (.status // "running") as $status
  | (.tokenCount // 0) as $tokens
  | (.contextWindowSize // null) as $ctxSize
  | (
      if $status == "running" then "▸"
      elif ($status == "waiting" or $status == "pending" or $status == "queued") then "◦"
      elif ($status == "failed" or $status == "error") then "✗"
      elif ($status == "done" or $status == "completed") then "✓"
      else "•"
      end
    ) as $icon
  | (
      if $tokens >= 1000 then
        (( ($tokens / 1000 * 10 | round) / 10 ) | tostring) + "k"
      else
        ($tokens | tostring)
      end
    ) as $tokensFmt
  | (
      if $ctxSize != null and $ctxSize > 0 then
        " " + (( ($tokens / $ctxSize * 100 * 10 | round) / 10 ) | tostring) + "%"
      else
        ""
      end
    ) as $pctStr
  | ($icon + " " + $label + " " + $tokensFmt + "tok" + $pctStr) as $content
  | {id: .id, content: $content[0:$cols]}
'
