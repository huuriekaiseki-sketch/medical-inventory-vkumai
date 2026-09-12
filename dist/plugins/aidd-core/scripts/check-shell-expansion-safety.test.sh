#!/usr/bin/env bash
# WHY(2026-09-10): bash の既定値つき展開に `{` で始まる値を書くと、**静かに違う値になる**。
#
#      `"${1:-{}}"` は「引数が無ければ空の JSON」のつもりで書けるが、bash は
#      `${1:-{` までを 1 つの展開と読み、残りの `}` を**素の文字として後ろに足す**。
#        - 引数が無いとき  → `{` + `}` = `{}`  … 偶然そう見える
#        - 引数があるとき  → `<値>` + `}`      … **末尾に } が増える**
#      つまり**引数を渡したときだけ壊れる**ので、既定値だけを試す軽い確認では通ってしまう。
#
#      実害(2026-09-10): eval の使用量を積む `accumulate_usage` がこの形で書かれており、
#      渡された JSON が `...}}` になって毎回 JSON として読めず、
#      **実測できた回まで「使用量を取れなかった」に落ちていた**（費用が永久に 0 件になる）。
#      検査（scripts/check-agent-output.test.sh のシナリオ 7）が掴んで判明した。
#
#      直し方は既定値に `{` を書かないこと（`${1:-}` にして、空なら空のまま扱う）。
#      ここでは (1) その書き方が 1 つも残っていないこと (2) **実際に壊れること**（対照）を測る。
#
# 限界: 走査するのは scripts/**/*.sh と .claude/**/*.sh のみ。コメント行は実行されないので対象外。
#       bash の展開の落とし穴はこれだけではない（`${a[@]}` の未定義・`${!x}` の間接展開など）。
#
# 実行: bash scripts/check-shell-expansion-safety.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を導入先だと思い込み、導入先の木を一度も見ないまま緑になる（E-086）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "$2"; fail=1; }

echo "=== scenario 1: 既定値が { で始まる展開が残っていない ==="
HITS="$(python3 - "$REPO_ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
# ${VAR:-{...}} / ${VAR-{...}} / ${VAR:={...}} など、既定値が `{` で始まる形
pat = re.compile(r"\$\{[A-Za-z_0-9#@*]+:?[-=+?]\{")
count = 0
seen = set()
for pattern in ("scripts/**/*.sh", ".claude/**/*.sh"):
    for p in sorted(root.glob(pattern)):
        if p in seen:
            continue
        seen.add(p)
        for i, line in enumerate(p.read_text(encoding="utf-8").split("\n"), 1):
            if line.lstrip().startswith("#"):
                continue
            if pat.search(line):
                print(f"{p.relative_to(root)}:{i}  {line.strip()}")
                count += 1
print(f"__COUNT__ {count}")
PY
)"
COUNT="$(sed -n 's/^__COUNT__ //p' <<<"$HITS")"
LIST="$(grep -v '^__COUNT__' <<<"$HITS" || true)"
if [ "${COUNT:-0}" -eq 0 ]; then
  ok "既定値が { で始まる展開は 0 箇所"
else
  ng "既定値に { を書いている箇所が ${COUNT} 件あります（末尾に } が増えます）" "$LIST"
fi

echo "=== scenario 2: 走査対象が空でない（fail-open 防止） ==="
# WHY(C-021): 走査が壊れると違反 0 件で合格に見える。数えた本数を先に見る
SCANNED="$(find "$REPO_ROOT/scripts" -name '*.sh' -type f | wc -l | tr -d ' ')"
# WHY(2026-09-12): 以前は 20 本未満を「走査が壊れている」として落としていたが、
#      **配った先の導入先は小さいことがある**（実測: 導入先を模した 2 リポジトリで 1 本と 0 本）。
#      0 本は「走査が壊れている」ではなく「この導入先に .sh が無い」ほうが普通なので、
#      対象なしとして黙る。違反 0 件と対象なしを混同しないよう、文言で区別する（C-021）。
#      限界: 中心リポジトリで根の解決が壊れて 0 本になった場合もここで黙る。
#      同じ根を使う検査が同時に大量に落ちるので、この 1 本だけでは守らない。
if [ "$SCANNED" -eq 0 ]; then
  ok "走査対象の .sh がこの導入先に 1 本も無いので対象なし"
else
  ok "${SCANNED} 本の .sh を走査した"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 3: その書き方は実際に値を壊す（対照） ==="
# WHY(この形をこのファイルに直接書かない): scenario 1 の走査が自分自身を違反として拾う。
#      危ない形は printf で組み立て、このファイルには残さない。
OPEN='{'
CLOSE='}'
printf 'v="${1:-%s%s}"\nprintf "%%s" "$v"\n' "$OPEN" "$CLOSE" > "$WORK/bad.sh"
printf 'v="${1:-}"\nprintf "%%s" "$v"\n' > "$WORK/good.sh"

BAD_OUT="$(bash "$WORK/bad.sh" 'X' 2>/dev/null)"
GOOD_OUT="$(bash "$WORK/good.sh" 'X' 2>/dev/null)"

if [ "$BAD_OUT" = "X" ]; then
  # この bash では壊れない。走査だけが防御になることを伝える（黙って合格にしない）
  echo "  ➖ この bash（${BASH_VERSION}）では値が壊れませんでした。走査（scenario 1）だけが防御です"
else
  ok "引数を渡すと値が壊れる（実測: [${BAD_OUT}]。走査が空振りでない裏づけ）"
fi

if [ "$GOOD_OUT" = "X" ]; then
  ok "既定値に { を書かなければ壊れない（対照）"
else
  ng "正しい書き方まで壊れる（この検査の前提が壊れている）" "実測: [${GOOD_OUT}]"
fi

echo "=== scenario 4: 引数が無いときは偶然そう見える（見逃しやすさの記録） ==="
# WHY: この形が長く生き残るのは、**既定値だけを試すと正しく見える**から。
#      「軽く試したら通った」で終えないよう、その挙動をここに固定しておく。
BAD_EMPTY="$(bash "$WORK/bad.sh" 2>/dev/null)"
if [ "$BAD_EMPTY" = "{}" ]; then
  ok "引数が無いときは {} に見える（＝軽い確認では気づけない。渡して確かめること）"
else
  echo "  ➖ この bash では引数無しでも {} になりませんでした（実測: [${BAD_EMPTY}]）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
