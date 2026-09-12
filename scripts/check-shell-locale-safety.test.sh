#!/usr/bin/env bash
# WHY(2026-09-10、レビュー指摘 R12): bash 3.2（macOS 標準）＋ UTF-8 ロケールでは、
#      `"$VAR）"` のように **変数展開の直後に全角文字**が来ると、その先頭バイト（0xEF）を
#      変数名の一部として読み、`set -u` の下で `VAR\xef: unbound variable` で異常終了する。
#      日本語で書いたメッセージほど踏みやすく、しかも **C ロケールでは再現しない**。
#
#      実測（2026-09-10）: hook 回帰 117 本を LC_ALL=C で回すと 117/0、
#      LC_ALL=ja_JP.UTF-8 で回すと 101/16。**16 本は実利用のロケールでだけ落ちていた**。
#      「テストは緑」だったのは、テストを C ロケールで回していたから。
#
#      直し方は `${VAR}` と明示的に区切ること。ここでは
#        (1) 危ない書き方が 1 つも残っていないこと（走査）
#        (2) 実際にその書き方が UTF-8 で落ちること（対照。走査が空振りでないことの裏づけ）
#        (3) `${VAR}` なら落ちないこと（対照）
#      を測る。
#
# 限界: 走査するのは `scripts/**/*.sh` のみ。コメント行は実行されないので対象外。
#       ロケールに由来する落とし穴はこれだけではない（LC_COLLATE による sort 順など）。
#
# 実行: bash scripts/check-shell-locale-safety.test.sh
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

echo "=== scenario 1: 全角文字に隣接した \$VAR が残っていない ==="
HITS="$(python3 - "$REPO_ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
pat = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])")
count = 0
for p in sorted(root.glob("scripts/**/*.sh")):
    for i, line in enumerate(p.read_text(encoding="utf-8").split("\n"), 1):
        if line.lstrip().startswith("#"):
            continue
        for m in pat.finditer(line):
            print(f"{p.relative_to(root)}:{i}  ${m.group(1)} -> ${{{m.group(1)}}}")
            count += 1
print(f"__COUNT__ {count}")
PY
)"
COUNT="$(sed -n 's/^__COUNT__ //p' <<<"$HITS")"
LIST="$(grep -v '^__COUNT__' <<<"$HITS" || true)"
if [ "${COUNT:-0}" -eq 0 ]; then
  ok "危ない書き方は 0 箇所"
else
  ng "全角文字の直前で変数を閉じていない箇所が ${COUNT} 件あります（\${VAR} と書く）" "$LIST"
fi

echo "=== scenario 2: 走査対象が空でない（fail-open 防止） ==="
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

# 実行に使うロケール。ja_JP.UTF-8 が無い環境では他の UTF-8 ロケールへ落ちる
AVAILABLE="$(locale -a 2>/dev/null || true)"
PROBE_LOCALE=""
for L in ja_JP.UTF-8 en_US.UTF-8 C.UTF-8; do
  if grep -qxF "$L" <<<"$AVAILABLE"; then
    PROBE_LOCALE="$L"
    break
  fi
done

echo "=== scenario 3: 危ない書き方は UTF-8 ロケールで実際に落ちる（対照） ==="
# WHY(全角括弧を変数で組み立てる): この対照は**わざと危ない書き方**を作るものなので、
#      そのままここに書くと scenario 1 の走査が自分自身を違反として拾う。
#      文字そのものはバイト列から作り、このファイルには残さない。
FW_OPEN="$(printf '\xef\xbc\x88')"
FW_CLOSE="$(printf '\xef\xbc\x89')"
printf 'set -u\nNAME="%s"\necho "%s$NAME%s"\n' "ok" "$FW_OPEN" "$FW_CLOSE" > "$WORK/bad.sh"
printf 'set -u\nNAME="%s"\necho "%s${NAME}%s"\n' "ok" "$FW_OPEN" "$FW_CLOSE" > "$WORK/good.sh"

if [ -z "$PROBE_LOCALE" ]; then
  echo "  ➖ UTF-8 ロケールがこの環境に無いので対照は測れません（走査だけ有効）"
else
  if LC_ALL="$PROBE_LOCALE" bash "$WORK/bad.sh" >/dev/null 2>&1; then
    # bash 4 以降や環境によっては落ちない。落ちないこと自体は問題ではないが、
    # **この対照が効いていない**ことは伝える（走査だけが頼りになる）
    echo "  ➖ この bash（${BASH_VERSION}）では危ない書き方でも落ちませんでした。走査（scenario 1）だけが防御です"
  else
    ok "危ない書き方は ${PROBE_LOCALE} で落ちる（走査が空振りでない裏づけ）"
  fi

  if LC_ALL="$PROBE_LOCALE" bash "$WORK/good.sh" >/dev/null 2>&1; then
    ok "\${VAR} と書けば ${PROBE_LOCALE} でも落ちない"
  else
    ng "正しい書き方まで落ちる（この検査の前提が壊れている）"
  fi
fi

echo "=== scenario 4: 実利用のロケールで検査を回す道がある ==="
# WHY: 直したこと自体は scenario 1 が見るが、**回すロケールを C に固定したままだと
#      次の落とし穴も同じように見逃す**。CI と手元の両方で UTF-8 でも回せることを固定する。
if grep -rq "LC_ALL" "$REPO_ROOT/.github/workflows" 2>/dev/null; then
  ok "CI がロケールを明示している"
else
  echo "  ➖ CI はロケールを明示していません（runner の既定に従います）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
