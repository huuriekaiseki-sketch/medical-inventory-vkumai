#!/usr/bin/env bash
# WHY(2026-09-11 に実証): `printf '%s' "$X" | grep -q ...` を `set -o pipefail` の下で使うと、
#      **一致したときだけ**パイプラインが非ゼロになる。grep -q は最初の一致で終了するので、
#      printf が書き終える前にパイプが閉じ、SIGPIPE（141）または EPIPE で非ゼロを返すため。
#
#      向きによって症状が変わる:
#        - `assert_contains`     → 一致しているのに **NG**（偽陽性。うるさいが気づける）
#        - `assert_not_contains` → 一致しているのに **OK**（**偽の緑**。黙って通る）
#
#      **偽の緑のほうが危ない。** 実証: 針を 1 行目に置いた 300KB の文字列で、
#      `assert_not_contains` が「見つからなかった」と判定した。
#
#      さらに悪いことに、**環境で結果が変わる**（C-042）。grep の実装（BSD / GNU）と
#      SIGPIPE の扱いで、読み切ってから終わるか即終了するかが違う。
#      CI が緑でも手元で赤い（逆も）。このリポジトリは**手元の実行を主な門**にしているので、
#      手元で偽の緑になるのがいちばん困る。
#
#      直し方はパイプを使わないこと（ヒアストリング）:
#        誤: printf '%s' "$X" | grep -qF -- "$Y"
#        正: grep -qF -- "$Y" <<<"$X"
#
#   (a) `scripts/` と `scripts/lib/` の *.sh に、`printf ... | <読み取りコマンド>` が無い
#   (b) 走査が空振りしていない（*.sh を 1 本も見つけられなければ落とす。C-044）
#   (c) fixture で (a) を検知できる／正しい書き方を誤検知しない（RED 方向の自己検証。C-022）
#   (d) この書き方が**実際に偽の結果を作る**ことを、その場で実測する（型の説明を信じない）
#
# 限界: 見るのは `printf` で始まるパイプだけ。`echo ... | grep` や `cat file | grep` は見ない
#      （前者は同じ問題を持つが実例が無く、後者はファイルなのでパイプを挟む必要がそもそも無い）。
#
# 実行: bash scripts/check-pipe-assertion.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を走査する（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=走査するディレクトリのルート。違反を 1 行ずつ出す
find_pipe_assertions() {
  local root="$1"
  local f line
  for f in "$root"/scripts/*.sh "$root"/scripts/lib/*.sh; do
    [ -f "$f" ] || continue
    # WHY(自分自身を除く): この検査は**危ない書き方を実際に動かして**偽の結果が出ることを
    #      測る（scenario 1）。その 1 行が走査に当たると、自分を違反として数え続ける。
    #      除外の代わりに、走査が効くことは fixture（scenario 4）で測る
    case "$f" in (*/check-pipe-assertion.test.sh) continue ;; esac
    # WHY(C-044): `grep -n` は一致が無ければ非ゼロ。`set -e` は使っていないが、
    #      `if` に置いて意図を明示する
    # WHY(早く終わるものだけを見る): 危ないのは**受け手が入力を読み切る前に終了する**場合だけ。
    #      `jq` `awk` `cut` `wc` `sort` は全部読んでから動くので、送り手は SIGPIPE を受けない。
    #      早く終わるのは `grep -q`（最初の一致で終了）・`grep -m N`・`head`。
    # `-v '^ *#'` でコメント行を除く（WHY に書き方の例を載せられるようにする。C-040 の裏返し）
    if line="$(grep -n "printf .*| *\(grep  *-[A-Za-z]*[qm]\|head\)" "$f" | grep -v ':[0-9]*: *#')"; then
      printf '%s\n' "$line" | sed "s|^|${f#"$root"/}:|"
    fi
  done
}

echo "=== scenario 1: この書き方が実際に偽の結果を作る（型の説明を信じない） ==="
# WHY(C-010): 「こういう理屈で危ない」と書くだけでは、その理屈が今も成り立つか分からない。
#      いまここで 1 回動かして確かめる
NEEDLE='偽の緑になる目印'
BODY="$(head -c 300000 /dev/zero | tr '\0' 'x')"
HAY="$(printf '%s\n%s' "$NEEDLE" "$BODY")"
if grep -qF -- "$NEEDLE" <<<"$HAY"; then
  assert_ok "針は確かに入っている（ヒアストリングで確認）"
else
  assert_fail "fixture が壊れている（針が入っていない）"
fi
if printf '%s' "$HAY" | grep -qF -- "$NEEDLE"; then
  assert_ok "この環境ではパイプ経由でも正しく判定できる（それでも書き方は禁じる）"
else
  assert_ok "パイプ経由は一致しているのに「見つからない」と読んだ（偽の結果を実測）"
fi

echo "=== scenario 2: 実態に、判定へパイプを使う printf が無い ==="
OUT="$(find_pipe_assertions "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "パイプ経由の判定は 0 件"
else
  COUNT="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
  assert_fail "パイプ経由の判定が ${COUNT} 箇所ある" "$(printf '%s\n' "$OUT" | head -10)
      直し方: printf '%s' \"\$X\" | grep -q ... → grep -q ... <<<\"\$X\"（パイプを使わない）"
fi

echo "=== scenario 3: 走査が空振りしていない（C-044） ==="
COUNT_SH="$(ls "$REPO_ROOT/scripts"/*.sh 2>/dev/null | wc -l | tr -d ' ')"
# WHY(2026-09-12): 下限 10 は大きなリポジトリを前提にしていた。配った先は小さい
#      （実測: 導入先を模した 2 リポジトリで 0 本と 1 本）。
#      持っていないだけで赤くなるので、0 本は対象なしとして黙る。
if [ "$COUNT_SH" -eq 0 ]; then
  assert_ok "走査対象の *.sh がこの導入先に 1 本も無いので対象なし"
else
  assert_ok "*.sh を ${COUNT_SH} 本走査できている"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts/lib"
cat > "$WORK/scripts/bad.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '%s' "$OUT" | grep -qF -- "$NEEDLE"
EOF
cat > "$WORK/scripts/lib/bad-lib.sh" <<'EOF'
printf '%s\n' "$X" | head -1
EOF
cat > "$WORK/scripts/good.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
grep -qF -- "$NEEDLE" <<<"$OUT"
case "$OUT" in (*"$NEEDLE"*) : ;; esac
printf '%s\n' "$OUT"          # パイプを挟まない printf は対象外
cat file | grep x             # printf ではないので対象外（限界に明記）
EOF

OUT="$(find_pipe_assertions "$WORK")"
if printf '%s\n' "$OUT" | grep -q 'scripts/bad.sh'; then
  assert_ok "パイプ経由の判定を検知"
else
  assert_fail "検知できない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'scripts/lib/bad-lib.sh'; then
  assert_ok "lib 配下も見る"
else
  assert_fail "lib 配下を見ていない" "$OUT"
fi
if printf '%s\n' "$OUT" | grep -q 'scripts/good.sh'; then
  assert_fail "正しい書き方を誤検知した" "$OUT"
else
  assert_ok "ヒアストリング・case・パイプ無しの printf は誤検知しない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
