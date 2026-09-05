# summarize-instructions-loaded.sh から `jq -r -s -f` で呼ばれる集計フィルタ（issue #742）。
# 入力: instructions-loaded.jsonl 全行の配列（-s）。引数: $since（期間下限 ISO8601）、$days。
# シェル側から分離した理由: `|` を含む jq フィルタは Bash ガードに誤検知されるため。

def fmt_file_rows:
  map("  - \(.filePath): \(.fileChars // "?")文字（\(.fileSizeBytes // "?")B）")
  | join("\n");

(map(select(.timestamp >= $since))) as $recent
| ($recent | map(.sessionId) | unique | length) as $sessions
| (
    # 直近セッション = timestamp が最大の行の sessionId
    if ($recent | length) == 0 then null
    else ($recent | max_by(.timestamp) | .sessionId) end
  ) as $latest
# 起動時ロード = session_start（CLAUDE.md・paths 無し rules）+ include（@import 先）。
# 2026-09-05 の実測で @import 先は load_reason "include" で来ると分かった（docs の記述どおり）。
# path_glob_match（paths 付き rules の遅延ロード）と compact（再ロード）は起動時量に含めない
| ($recent | map(select(.sessionId == $latest and (.loadReason == "session_start" or .loadReason == "include")))) as $start_rows
| ($start_rows | map(.fileChars // 0) | add // 0) as $start_chars
# project 配下（相対パス）だけの合計。check-claude-md-size.sh は個人の ~/.claude/CLAUDE.md を
# 測れない（hook から $HOME 配下を安全に読めない）ため、突き合わせはこちらの値で行う
| ($start_rows | map(select(.filePath | startswith("/") | not) | .fileChars // 0) | add // 0) as $start_chars_project
| (
    $recent
    | group_by(.filePath)
    | map({
        filePath: .[0].filePath,
        total: length,
        byReason: (group_by(.loadReason) | map({key: .[0].loadReason, value: length}) | from_entries)
      })
    | sort_by(-.total)
  ) as $per_file
| [
    "## InstructionsLoaded 実測（直近\($days)日、\($sessions)セッション、issue #742）",
    "",
    "### 直近セッション（\($latest // "なし")）の起動時ロード量（session_start + include）: 合計 \($start_chars) 文字（うち project 配下 \($start_chars_project) 文字）",
    (if ($start_rows | length) == 0 then "  （起動時ロードの記録なし）" else ($start_rows | fmt_file_rows) end),
    "",
    "project 配下の値は check-claude-md-size.sh の自前計算（CLAUDE.md + @import + paths 無し rules）と同じ単位・同じ範囲。差があれば自前計算側の穴として扱う（個人の ~/.claude/CLAUDE.md は自前計算の対象外）。",
    "",
    "### ファイル別ロード回数（loadReason 別）",
    (if ($per_file | length) == 0 then "  （記録なし）"
     else ($per_file | map("  - \(.filePath): \(.total) 回 \(.byReason | tojson)") | join("\n")) end),
    "",
    "path_glob_match / include で一度も読まれない paths 付き rules は削除候補（読まれない規則は守られない）。"
  ]
| join("\n")
