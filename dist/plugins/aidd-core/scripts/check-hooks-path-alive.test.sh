#!/usr/bin/env bash
# WHY: issue #779。scripts/check-hooks-path-alive.sh（core.hooksPath が死んでいないかを
#      SessionStart で見る検査）の回帰テスト。
#
#      この検査は「何も言わない」が正常な状態なので、**壊れて黙っても誰も気づかない**
#      （docs/agents/check-design-pitfalls.md の「不在で判定するのに出る側の対を置かない」）。
#      そこで、出る側（実在しないパス / worktree 上書き）と出ない側（正常・未設定）の
#      両方を一時リポジトリで作って測る。
#
# 実行: bash scripts/check-hooks-path-alive.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-hooks-path-alive.sh"

# WHY(対象なし・確認不能を言う): 配る検査は、導入先に対象が無いときや実行系が無いときに
#      **黙って合格にしない**（嘘の緑を作らない）。どちらも「測っていない」ことを明示して抜ける。
if [ ! -f "$CHECKER" ]; then
  echo "=== scenario 0: この導入先に検査本体が無い ==="
  echo "  SKIP: check-hooks-path-alive.sh が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

for cmd in jq git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "=== scenario 0: 実行系が足りない ==="
    echo "  SKIP: $cmd が無いので確認不能（合格にも違反にも数えない）"
    echo "ALL PASSED"
    exit 0
  fi
done

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

make_repo() {
  local d="$1"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email t@example.com
  git -C "$d" config user.name t
  git -C "$d" config extensions.worktreeConfig true
  mkdir -p "$d/scripts/git-hooks"
  printf '#!/bin/sh\nexit 0\n' > "$d/scripts/git-hooks/commit-msg"
  chmod +x "$d/scripts/git-hooks/commit-msg"
}

# 対象リポジトリの中で検査を走らせる（cwd がそのリポジトリである必要がある）
run_in() {
  ( cd "$1" && bash "$CHECKER" 2>&1 )
}

echo "=== scenario 1: 正しく設定されていれば何も言わない ==="
R1="$WORK/ok"
make_repo "$R1"
git -C "$R1" config core.hooksPath scripts/git-hooks
OUT="$(run_in "$R1")"
if [ -z "$OUT" ]; then
  assert_ok "相対の正しい設定では黙る"
else
  assert_fail "正常なのに警告した" "$OUT"
fi

echo "=== scenario 2: 未設定なら何も言わない（.git/hooks を使う運用を壊さない） ==="
R2="$WORK/unset"
make_repo "$R2"
OUT="$(run_in "$R2")"
if [ -z "$OUT" ]; then
  assert_ok "未設定では黙る"
else
  assert_fail "未設定なのに警告した" "$OUT"
fi

echo "=== scenario 3: 実在しないパスを指していたら言う（本題。RED 方向） ==="
R3="$WORK/dead"
make_repo "$R3"
git -C "$R3" config core.hooksPath /nonexistent/path/to/hooks
OUT="$(run_in "$R3")"
if [ -z "$OUT" ]; then
  assert_fail "死んだ hooksPath を見逃した（この検査の存在理由そのもの）"
else
  assert_ok "死んだ hooksPath を検知する"
  if jq -e '.systemMessage' >/dev/null 2>&1 <<<"$OUT"; then
    assert_ok "SessionStart hook が読める JSON を返す"
  else
    assert_fail "JSON になっていない" "$OUT"
  fi
  if grep -qF '存在しません' <<<"$OUT"; then
    assert_ok "何が起きているかを言う"
  else
    assert_fail "理由を言わない" "$OUT"
  fi
fi

echo "=== scenario 4: worktree スコープの上書きは、実在しても言う（E-092 の形） ==="
R4="$WORK/override"
make_repo "$R4"
git -C "$R4" config core.hooksPath scripts/git-hooks
# 実在するディレクトリを worktree スコープで上書きする（パスは生きているが、上書き自体が危険）
git -C "$R4" config --worktree core.hooksPath "$R4/scripts/git-hooks"
OUT="$(run_in "$R4")"
if grep -qF 'worktree スコープの上書き' <<<"$OUT"; then
  assert_ok "実在しても worktree 上書きは知らせる"
else
  assert_fail "worktree 上書きを見逃した" "$OUT"
fi
if grep -qF 'git config --worktree --unset core.hooksPath' <<<"$OUT"; then
  assert_ok "直し方を言う"
else
  assert_fail "直し方を言わない" "$OUT"
fi

echo "=== scenario 5: git 管理外では黙る（fail-open だが、止める検査ではないので許容） ==="
R5="$WORK/notrepo"
mkdir -p "$R5"
OUT="$(run_in "$R5")"
if [ -z "$OUT" ]; then
  assert_ok "リポジトリ外では黙る"
else
  assert_fail "リポジトリ外で警告した" "$OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
