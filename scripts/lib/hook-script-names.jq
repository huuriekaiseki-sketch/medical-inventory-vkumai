# hook の登録（.claude/settings.json / .codex/hooks.json）から、起動するスクリプトの名前を取り出す。
# 1 行に「イベント<TAB>名前」。同じスクリプトが 2 つのイベントに登録されていれば 2 行出る。
# 使う側: scripts/codex-hook-gap.test.sh
.hooks
| to_entries[]
| .key as $event
| .value[]
| .hooks[]?
| .command // empty
| [match("scripts/(?:lib/)?([A-Za-z0-9._-]+\\.(?:sh|mjs|js|py))"; "g").captures[0].string]
| .[]
| "\($event)\t\(.)"
