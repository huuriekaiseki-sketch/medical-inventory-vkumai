#!/usr/bin/env bash
# WHY(2026-09-11): 2 本の .mjs に生の NUL が入り、git が binary と判定して diff / blame / merge が効かず、
#      grep 系の走査からも外れた。**検査 142 本のどれにも掛からなかった**（外部レビューで発見。E-082）。
#      原因は書き出しの経路で、エスケープのつもりの文字が実バイトになっていた（C-052）。
#      同じ日にコミットメッセージの下書きでも起きたので、ファイルとメッセージの両方を見る。
#
#   (a) 走査器が制御バイトを見つける（NUL・BS・VT・FF・ESC・DEL）。TAB・LF・CR と日本語は通す
#   (b) 作業ツリーのテキストファイルに制御バイトが無い（ratchet。2026-09-11 に 1,516 本で 0 本と実測して開始）
#   (c) HEAD から辿れるコミットメッセージに制御バイトが無い（同日 707 件で 0 件）
#   (d) 追跡ファイルとコミットの RED 方向、免除（aidd.config.json の controlBytes）の衛生（C-049）
#   (e) **add する前の未追跡ファイル**でも検知し、gitignore 済みは見ない（issue #785）
#   (f) 走査が空振りしていない・走査できないことを緑にしない（C-044 / C-025）
#
# 限界: 詳しくは scripts/lib/scan-control-bytes.mjs の先頭。コミットの**前に**止めるのは
#      git の commit-msg hook（scripts/git-hooks/commit-msg。bash scripts/install-git-hooks.sh で入る）で、
#      ここは入れていない clone や --no-verify で入ったものを後から拾う側。
#
# このファイル自身にも制御バイトを書かない。見本の制御バイトは実行時に printf の 8 進で作る。
#
# 実行: bash scripts/check-control-bytes.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=lib/aidd-config.sh
source "$SCRIPT_DIR/lib/aidd-config.sh"
SCANNER="$SCRIPT_DIR/lib/scan-control-bytes.mjs"

# WHY(2026-09-12): node が無い導入先で回すと、走査器が 127 で落ち、この検査は
#      「追跡ファイルは 18 本あるのに走査できたのが 0 本（走査が壊れている疑い）」と報告した。
#      **確かめられなかっただけ**なのに違反として出る。合格にも違反にも数えさせない。
command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので制御バイトを走査できない。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# $1=ファイル名 $2=printf の書式（制御バイトは 8 進で書く）
make_fixture() { printf "$2" > "$WORK/$1"; }

echo "=== scenario 1: 走査器が制御バイトを見つけ、許すものは通す ==="
make_fixture nul.txt 'a\000b\n'
make_fixture bs.txt 'a\010b\n'
make_fixture vt.txt 'a\013b\n'
make_fixture ff.txt 'a\014b\n'
make_fixture esc.txt 'a\033[31mb\n'
make_fixture del.txt 'a\177b\n'
make_fixture ok.txt 'tab\011here\015\n日本語の行\n'
for f in nul bs vt ff esc del; do
  if node "$SCANNER" --message "$WORK/${f}.txt" > "$WORK/out-${f}.txt" 2>&1; then
    assert_fail "${f} を見逃した" "$(cat "$WORK/out-${f}.txt")"
  else
    assert_ok "${f} を見つける"
  fi
done
if grep -q '1 行 2 バイト目 0x00' "$WORK/out-nul.txt"; then
  assert_ok "位置（行とバイト）と値を名指しする"
else
  assert_fail "位置を名指ししない" "$(cat "$WORK/out-nul.txt")"
fi
if node "$SCANNER" --message "$WORK/ok.txt" > "$WORK/out-ok.txt" 2>&1; then
  assert_ok "TAB・CR・LF と日本語（複数バイト文字）は通す"
else
  assert_fail "許すべきものを制御バイトと読んだ" "$(cat "$WORK/out-ok.txt")"
fi

echo "=== scenario 2: 作業ツリーのテキストファイルに制御バイトが無い（ratchet） ==="
aidd_config_query '.controlBytes.allowedFiles // {}' '{}' "$REPO_ROOT" > "$WORK/allow-files.json"
if OUT="$(node "$SCANNER" --files --root "$REPO_ROOT" --allow "$WORK/allow-files.json" 2>&1)"; then
  RC=0
else
  RC=$?
fi
SCANNED="$(sed -n 's/^scanned=//p' <<<"$OUT")"
if [ "$RC" -eq 0 ]; then
  assert_ok "制御バイトを含む追跡ファイルは 0 本（${SCANNED} 本を走査）"
elif [ "$RC" -eq 1 ]; then
  assert_fail "制御バイトを含む追跡ファイルがある" "$(head -10 <<<"$(grep '^NG ' <<<"$OUT")")
      直し方: 生のバイトを、文字で説明するか 16 進の形のエスケープへ替える。
      binary なら拡張子を scan-control-bytes.mjs の BINARY_EXT へ、要るなら controlBytes.allowedFiles に理由つきで足す"
else
  assert_fail "走査できない（rc=${RC}。走査できないことを緑にしない）" "$OUT"
fi
# WHY(2026-09-12): 下限 10 本は大きなリポジトリ前提だった。**まだ何も追跡していない導入先**では
#      0 本が普通で、持っていないだけで赤くなる（空のリポジトリで実測して発覚）。
#      scenario 3 が「コミットが無い」を対象なしと言えているのと同じ扱いに揃える。
#      「追跡ファイルが 1 本も無い」と「あるのに走査が 0 本」は別物なので分ける（C-025）。
# 走査器と同じ列挙（追跡中 + 未追跡、gitignore 済みは除く）で数える。片方だけ変えると空振り検知が狂う
LISTED_N="$(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard 2>/dev/null | grep -c . || true)"
if [ "${LISTED_N:-0}" -eq 0 ]; then
  assert_ok "対象なし: この導入先には走査できるファイルが 1 つも無い"
elif [ "${SCANNED:-0}" -ge 1 ]; then
  assert_ok "走査が空振りしていない（${SCANNED} 本）"
else
  assert_fail "対象は ${LISTED_N} 本あるのに走査できたのが 0 本（走査が壊れている疑い。C-044）"
fi

echo "=== scenario 3: HEAD から辿れるコミットメッセージに制御バイトが無い ==="
if ! git -C "$REPO_ROOT" rev-parse --verify --quiet HEAD > /dev/null; then
  assert_ok "この導入先にはまだコミットが無い（走査する対象が無い）"
else
  aidd_config_query '.controlBytes.allowedCommits // {}' '{}' "$REPO_ROOT" > "$WORK/allow-commits.json"
  if OUT="$(node "$SCANNER" --commits --root "$REPO_ROOT" --allow "$WORK/allow-commits.json" 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  SCANNED="$(sed -n 's/^scanned=//p' <<<"$OUT")"
  if [ "$RC" -eq 0 ]; then
    assert_ok "制御バイトを含むメッセージは 0 件（${SCANNED} 件を走査）"
  elif [ "$RC" -eq 1 ]; then
    assert_fail "制御バイトを含むコミットメッセージがある" "$(head -10 <<<"$(grep '^NG ' <<<"$OUT")")
      まだ push していなければ git commit --amend で直す。直せないものは controlBytes.allowedCommits に理由つきで足す"
  else
    assert_fail "走査できない（rc=${RC}）" "$OUT"
  fi
  if [ "${SCANNED:-0}" -ge 1 ]; then
    assert_ok "走査が空振りしていない（${SCANNED} 件）"
  else
    assert_fail "コミットを 1 件も読めない（走査が壊れている疑い。C-044）"
  fi
fi

echo "=== scenario 4: 追跡ファイルとコミットの RED 方向、免除の衛生 ==="
FX="$WORK/fx"
git init -q "$FX"
git -C "$FX" config user.email t@example.test
git -C "$FX" config user.name t
printf 'clean\n' > "$FX/clean.txt"
printf 'x\033[0my\n' > "$FX/ansi.txt"
git -C "$FX" add clean.txt ansi.txt
if OUT_FX="$(node "$SCANNER" --files --root "$FX" 2>&1)"; then RC_FX=0; else RC_FX=$?; fi
if [ "$RC_FX" -eq 1 ] && grep -q 'NG ansi.txt: 1 行 2 バイト目 0x1b' <<<"$OUT_FX"; then
  assert_ok "追跡ファイルの制御バイトを、ファイルと位置で名指しする"
else
  assert_fail "追跡ファイルの制御バイトを検知できない（rc=${RC_FX}）" "$OUT_FX"
fi
printf '{"ansi.txt":"端末の色の見本（ESC が要る）"}\n' > "$WORK/allow-ok.json"
if node "$SCANNER" --files --root "$FX" --allow "$WORK/allow-ok.json" > /dev/null 2>&1; then
  assert_ok "理由つきの免除があれば通す"
else
  assert_fail "理由つきの免除でも落ちる"
fi
printf '{"ansi.txt":"見本","clean.txt":"要らない免除"}\n' > "$WORK/allow-stale.json"
OUT_FX="$(node "$SCANNER" --files --root "$FX" --allow "$WORK/allow-stale.json" 2>&1)"
if grep -q '免除 clean.txt は一度も当たっていない' <<<"$OUT_FX"; then
  assert_ok "一度も当たらない免除を検知（C-049）"
else
  assert_fail "腐った免除を残せる" "$OUT_FX"
fi
printf '{"ansi.txt":"  "}\n' > "$WORK/allow-empty.json"
OUT_FX="$(node "$SCANNER" --files --root "$FX" --allow "$WORK/allow-empty.json" 2>&1)"
if grep -q '免除 ansi.txt の理由が空' <<<"$OUT_FX"; then
  assert_ok "理由が空の免除を検知"
else
  assert_fail "理由の無い免除を通す" "$OUT_FX"
fi

# コミットメッセージ: git は ESC を止めずに記録する（2026-09-11 実測）ので、履歴側で拾えることを見る
printf 'ok\n' > "$WORK/msg-ok.txt"
printf 'subject \033[31mred\n' > "$WORK/msg-esc.txt"
git -C "$FX" commit -q -F "$WORK/msg-ok.txt"
git -C "$FX" commit -q --allow-empty -F "$WORK/msg-esc.txt"
ESC_SHA="$(git -C "$FX" rev-parse HEAD)"
if OUT_FX="$(node "$SCANNER" --commits --root "$FX" 2>&1)"; then RC_FX=0; else RC_FX=$?; fi
if [ "$RC_FX" -eq 1 ] && grep -q "NG ${ESC_SHA:0:10}" <<<"$OUT_FX"; then
  assert_ok "履歴に入った制御バイトを、コミットで名指しする"
else
  assert_fail "履歴の制御バイトを検知できない（rc=${RC_FX}）" "$OUT_FX"
fi
if grep -q "$(printf '\033')" <<<"$OUT_FX"; then
  assert_fail "出力そのものに制御バイトを混ぜた（件名は ? に替えて出す）"
else
  assert_ok "出力には制御バイトを混ぜない"
fi
printf '{"%s":"見本として意図して残した"}\n' "${ESC_SHA:0:12}" > "$WORK/allow-commit.json"
if node "$SCANNER" --commits --root "$FX" --allow "$WORK/allow-commit.json" > /dev/null 2>&1; then
  assert_ok "コミットは先頭の桁で免除できる"
else
  assert_fail "コミットの免除が効かない"
fi

echo "=== scenario 5: コミット前（未追跡）でも検知し、gitignore 済みは見ない（issue #785） ==="
# WHY: 素の git ls-files は追跡中のものしか返さないので、**書いた直後にここを回すと必ず緑**になる。
#      E-082 の再発（生の NUL）をこの検査が 1 度取り逃がし、CI が拾った。E-039 と同じ穴。
UT="$WORK/ut"
git init -q "$UT"
printf 'ignored/\n' > "$UT/.gitignore"
printf 'clean\n' > "$UT/tracked.txt"
git -C "$UT" add .gitignore tracked.txt
printf 'x\033[0my\n' > "$UT/untracked.txt"          # add していない（＝コミット前の状態）
mkdir -p "$UT/ignored"
printf 'z\033[0mw\n' > "$UT/ignored/generated.txt"  # gitignore 済み（走査対象外であるべき）
if OUT_UT="$(node "$SCANNER" --files --root "$UT" 2>&1)"; then RC_UT=0; else RC_UT=$?; fi
if [ "$RC_UT" -eq 1 ] && grep -q 'NG untracked.txt: 1 行 2 バイト目 0x1b' <<<"$OUT_UT"; then
  assert_ok "add する前の未追跡ファイルでも検知する"
else
  assert_fail "未追跡ファイルを見逃す（rc=${RC_UT}）" "$OUT_UT"
fi
if grep -q 'ignored/generated.txt' <<<"$OUT_UT"; then
  assert_fail "gitignore 済みのファイルまで走査した（生成物で赤くなる）" "$OUT_UT"
else
  assert_ok "gitignore 済みは見ない"
fi

echo "=== scenario 6: 走査できないことを緑にしない（C-025） ==="
mkdir -p "$WORK/not-a-repo"
if node "$SCANNER" --files --root "$WORK/not-a-repo" > "$WORK/out-na.txt" 2>&1; then
  RC=0
else
  RC=$?
fi
if [ "$RC" -eq 2 ]; then
  assert_ok "git で読めない場所は 2（無い・ある とは別の答え）"
else
  assert_fail "走査できないのに ${RC} を返した" "$(cat "$WORK/out-na.txt")"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
