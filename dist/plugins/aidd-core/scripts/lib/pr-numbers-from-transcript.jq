# scripts/check-handoff-format.sh から `jq -s -r -f` で呼ばれる。
# transcript（JSONL を -s で配列化）から、このセッションで作成・編集した PR 番号を列挙する。
#
# WHY(2026-09-05): 以前は「Stop 時点の現在ブランチ」で `gh pr list --head` を引いていたが、
#   PR を作って CI を待ち、マージして main へ戻った後の Stop ではブランチが main になり PR が
#   見つからず沈黙していた（1 セッションで 14 本の PR を作ったのに 1 本も評価されなかった実測）。
#   PR 番号は transcript に残る `gh pr create` の tool_result（作成された PR の URL）と
#   `gh pr edit N` のコマンド文字列から取る。ブランチには依存しない。
#
# 出力: PR 番号を 1 行 1 つ（重複除去・昇順）。該当が無ければ何も出さない。
[ .[] | .message?.content? // empty | .[]? ] as $blocks
| ($blocks
   | map(select(.type == "tool_use" and .name == "Bash" and ((.input.command // "") | test("^gh pr create"))))
   | map(.id)) as $create_ids
| (
    [ $blocks[]
      | select(.type == "tool_result" and (.tool_use_id as $id | $create_ids | index($id)))
      | (.content | if type == "string" then . elif type == "array" then (map(.text? // "") | join("\n")) else "" end)
      | capture("/pull/(?<n>[0-9]+)") | .n ]
    + [ $blocks[]
        | select(.type == "tool_use" and .name == "Bash")
        | (.input.command // "")
        | capture("^gh pr edit (?<n>[0-9]+)") | .n ]
  )
| map(tonumber) | unique | .[]
