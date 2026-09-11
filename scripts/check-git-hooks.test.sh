#!/usr/bin/env bash
# WHY(2026-09-11): リポジトリで管理する git hooks（scripts/git-hooks/）と入れ方の回帰テスト。
#      hook は「入っていないと黙って何もしない」「実行ビットが無いと git が黙って無視する」ので、
#      動くことを 1 つずつ確かめる（入れた気になって動かない、を緑にしない。C-044）。
#
#   (a) hook のファイルは git に実行ビット付き（100755）で入っている
#   (b) 入れ方（scripts/install-git-hooks.sh）が core.hooksPath を向け、外せる。
#       別の向き先・既存の有効な hook は壊さない
#   (c) commit-msg: 制御バイトのあるメッセージは止め、ふつうの日本語は通す。判定できないときは止めない
#
# 本物の git の中で動かす（一時リポジトリにコミットして確かめる）。このリポジトリの設定には触れない。
#
# 実行: bash scripts/check-git-hooks.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALLER="$SCRIPT_DIR/install-git-hooks.sh"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HOOKS="commit-msg"

echo "=== scenario 1: hook は実行ビット付きで git に入っている ==="
for h in $HOOKS; do
  entry="$(git -C "$REPO_ROOT" ls-files -s "scripts/git-hooks/${h}")"
  mode="${entry%% *}"
  if [ "$mode" = "100755" ]; then
    assert_ok "${h} は 100755"
  else
    assert_fail "${h} の mode が ${mode:-（git に入っていない）}（git は実行ビットの無い hook を黙って無視する）"
  fi
done

# 一時リポジトリに hook 一式と走査器を置く（このリポジトリの設定には触れない）
make_repo() {
  local d="$1"
  git init -q "$d"
  git -C "$d" config user.email t@example.test
  git -C "$d" config user.name t
  mkdir -p "$d/scripts/git-hooks" "$d/scripts/lib"
  cp -p "$REPO_ROOT"/scripts/git-hooks/* "$d/scripts/git-hooks/"
  cp -p "$REPO_ROOT/scripts/lib/scan-control-bytes.mjs" "$REPO_ROOT/scripts/lib/stdout-sync.mjs" "$d/scripts/lib/"
}
install_in() {
  local d="$1"
  shift
  (cd "$d" && bash "$INSTALLER" "$@")
}

echo "=== scenario 2: 入れ方が core.hooksPath を向け、何度打っても同じ ==="
R="$WORK/repo"
make_repo "$R"
if install_in "$R" > "$WORK/install.out" 2>&1; then
  assert_ok "入れられる"
else
  assert_fail "入れられない" "$(cat "$WORK/install.out")"
fi
if [ "$(git -C "$R" config --get core.hooksPath)" = "scripts/git-hooks" ]; then
  assert_ok "core.hooksPath が scripts/git-hooks を向く（相対。各 worktree の最上位から解決される）"
else
  assert_fail "core.hooksPath が向いていない"
fi
if install_in "$R" > "$WORK/install2.out" 2>&1 && grep -qF '既に入っています' "$WORK/install2.out"; then
  assert_ok "2 回目は何も変えない"
else
  assert_fail "2 回目の挙動がおかしい" "$(cat "$WORK/install2.out")"
fi

echo "=== scenario 3: commit-msg は制御バイトのメッセージを止め、ふつうの日本語は通す ==="
printf '日本語の件名\n\n本文の行\n' > "$WORK/ok.msg"
if git -C "$R" commit -q --allow-empty -F "$WORK/ok.msg" 2> "$WORK/c.err"; then
  assert_ok "ふつうの日本語は通す"
else
  assert_fail "ふつうのメッセージを止めた" "$(cat "$WORK/c.err")"
fi
BEFORE="$(git -C "$R" rev-parse HEAD)"
for kind in esc del bs; do
  case "$kind" in
    esc) printf 'subject \033[31mred\n' > "$WORK/bad.msg" ;;
    del) printf 'subject \177del\n' > "$WORK/bad.msg" ;;
    bs) printf 'subject \010bs\n' > "$WORK/bad.msg" ;;
  esac
  if git -C "$R" commit -q --allow-empty -F "$WORK/bad.msg" 2> "$WORK/c.err"; then
    assert_fail "${kind} を含むメッセージを通した（git 自身は ${kind} を止めない）"
  elif grep -qF '[commit-msg]' "$WORK/c.err"; then
    assert_ok "${kind} を止める（git 自身は止めないもの）"
  else
    assert_fail "止まったが hook の理由が出ていない" "$(cat "$WORK/c.err")"
  fi
done
if [ "$(git -C "$R" rev-parse HEAD)" = "$BEFORE" ]; then
  assert_ok "止めたコミットは 1 つも履歴に入っていない"
else
  assert_fail "止めたはずのコミットが履歴に入った"
fi

echo "=== scenario 4: 判定できないときは止めない（壊れた hook で全員のコミットを止めない） ==="
R2="$WORK/repo2"
make_repo "$R2"
install_in "$R2" > /dev/null 2>&1
rm -f "$R2/scripts/lib/scan-control-bytes.mjs"
printf 'subject \033[31mred\n' > "$WORK/bad.msg"
if git -C "$R2" commit -q --allow-empty -F "$WORK/bad.msg" 2> "$WORK/c.err"; then
  assert_ok "走査器が無ければ止めない（取りこぼしは hooks-test の走査が後から拾う）"
else
  assert_fail "判定できないのに止めた" "$(cat "$WORK/c.err")"
fi

echo "=== scenario 5: 入れ方は、別の向き先と既存の有効な hook を壊さない・外せる ==="
R3="$WORK/repo3"
make_repo "$R3"
git -C "$R3" config core.hooksPath other/hooks
if install_in "$R3" > "$WORK/i3.out" 2>&1; then
  assert_fail "別の向き先を上書きした"
else
  assert_ok "別の向き先があれば止まる"
fi
if [ "$(git -C "$R3" config --get core.hooksPath)" = "other/hooks" ]; then
  assert_ok "別の向き先はそのまま"
else
  assert_fail "別の向き先が書き換わった"
fi

R4="$WORK/repo4"
make_repo "$R4"
printf '#!/bin/sh\nexit 0\n' > "$R4/.git/hooks/pre-commit"
chmod +x "$R4/.git/hooks/pre-commit"
if install_in "$R4" > "$WORK/i4.out" 2>&1; then
  assert_fail "既存の有効な hook を黙って素通りにした"
elif grep -qF 'pre-commit' "$WORK/i4.out"; then
  assert_ok "既存の有効な hook があれば、名指しして止まる"
else
  assert_fail "止まったが理由を名指ししない" "$(cat "$WORK/i4.out")"
fi
if install_in "$R4" --force > /dev/null 2>&1 && [ "$(git -C "$R4" config --get core.hooksPath)" = "scripts/git-hooks" ]; then
  assert_ok "--force なら承知の上で向けられる"
else
  assert_fail "--force でも向けられない"
fi

if install_in "$R" --uninstall > /dev/null 2>&1 && [ -z "$(git -C "$R" config --get core.hooksPath || true)" ]; then
  assert_ok "--uninstall で外せる"
else
  assert_fail "外せない"
fi

echo "=== scenario 6: 実行ビットの無い hook は、入れる時点で止める ==="
R5="$WORK/repo5"
make_repo "$R5"
chmod -x "$R5/scripts/git-hooks/commit-msg"
if install_in "$R5" > "$WORK/i5.out" 2>&1; then
  assert_fail "実行ビットの無い hook を入れた（git は黙って無視する）"
else
  assert_ok "実行ビットの無い hook があれば入れない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
