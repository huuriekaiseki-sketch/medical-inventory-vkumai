#!/usr/bin/env bash
# WHY(2026-09-11): リポジトリで管理する git hooks（scripts/git-hooks/）と入れ方の回帰テスト。
#      hook は「入っていないと黙って何もしない」「実行ビットが無いと git が黙って無視する」ので、
#      動くことを 1 つずつ確かめる（入れた気になって動かない、を緑にしない。C-044）。
#
#   (a) hook のファイルは git に実行ビット付き（100755）で入っている
#   (b) 入れ方（scripts/install-git-hooks.sh）が core.hooksPath を向け、外せる。
#       別の向き先・既存の有効な hook は壊さない
#   (c) commit-msg: 制御バイトのあるメッセージは止め、ふつうの日本語は通す。判定できないときは止めない
#   (d) pre-push: GitHub の main への直接 push（削除を含む）は止め、ブランチと GitLab の控えは通す（H-001）
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

HOOKS="commit-msg pre-push"

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

echo "=== scenario 7: pre-push は GitHub の main への直接 push を止め、ブランチと控えは通す（H-001） ==="
# WHY(2026-09-11、外部レビュー): 溜まった main をそのまま GitHub へ push すると、CI を一度も通さずに
#      正本へ入る。Free プランでは GitHub 側でブランチ保護を掛けられないので、手元で止める
PRE="$REPO_ROOT/scripts/git-hooks/pre-push"
Z=0000000000000000000000000000000000000000
S=1111111111111111111111111111111111111111
# $1=remote の URL $2=送り先の ref $3=送る側の sha（削除なら 0 の並び）→ 終了コード
run_pre() {
  printf 'refs/heads/main %s %s %s\n' "${3:-$S}" "$2" "$Z" | bash "$PRE" origin "$1" > "$WORK/pp.out" 2>&1
}
if run_pre git@github.com:o/r.git refs/heads/main; then
  assert_fail "GitHub の main への push を通した"
elif grep -qF '[pre-push]' "$WORK/pp.out"; then
  assert_ok "GitHub の main への push を止め、理由と正しい入れ方を言う"
else
  assert_fail "止まったが理由を言わない" "$(cat "$WORK/pp.out")"
fi
if run_pre https://github.com/o/r.git refs/heads/main "$Z"; then
  assert_fail "GitHub の main の削除を通した"
else
  assert_ok "GitHub の main の削除も止める"
fi
if run_pre git@github.com:o/r.git refs/heads/recovery/local-main; then
  assert_ok "GitHub のブランチへの push は通す（PR を作るための入れ方）"
else
  assert_fail "GitHub のブランチへの push を止めた" "$(cat "$WORK/pp.out")"
fi
if run_pre https://gitlab.com/g/r.git refs/heads/main; then
  assert_ok "GitLab（控え）の main への push は通す"
else
  assert_fail "GitLab への push を止めた" "$(cat "$WORK/pp.out")"
fi

# 本物の git の push で確かめる（URL に github.com を含む手元の bare リポジトリを GitHub に見立てる）
R6="$WORK/repo6"
make_repo "$R6"
install_in "$R6" > /dev/null 2>&1
git -C "$R6" commit -q --allow-empty -m 'first'
git -C "$R6" branch -M main
mkdir -p "$WORK/github.com/o" "$WORK/gitlab.com/g"
git init -q --bare "$WORK/github.com/o/r.git"
git init -q --bare "$WORK/gitlab.com/g/r.git"
git -C "$R6" remote add fakegh "$WORK/github.com/o/r.git"
git -C "$R6" remote add fakegl "$WORK/gitlab.com/g/r.git"
if git -C "$R6" push -q fakegh main > "$WORK/push.out" 2>&1; then
  assert_fail "本物の push で GitHub の main へ入った"
else
  assert_ok "本物の push でも GitHub の main へは入らない"
fi
if git -C "$WORK/github.com/o/r.git" rev-parse --verify --quiet refs/heads/main > /dev/null; then
  assert_fail "止めたはずの main が GitHub 側にできている"
else
  assert_ok "GitHub 側に main はできていない"
fi
if git -C "$R6" push -q fakegh main:refs/heads/recovery/local-main > "$WORK/push.out" 2>&1; then
  assert_ok "本物の push でブランチとしては入れられる"
else
  assert_fail "ブランチとしても入れられない" "$(cat "$WORK/push.out")"
fi
if git -C "$R6" push -q fakegl main > "$WORK/push.out" 2>&1; then
  assert_ok "本物の push で GitLab の main へは入れられる（控え）"
else
  assert_fail "GitLab へ入れられない" "$(cat "$WORK/push.out")"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
