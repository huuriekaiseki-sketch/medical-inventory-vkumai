#!/usr/bin/env bash
# WHY: issue #757 の 10（秘密情報と出口側）の残り。`check-secret-leak.test.sh` は
#      **いまの追跡ファイル**しか見ない。一度コミットした秘密は、そのファイルを消しても
#      git のオブジェクトに残り続け、clone した全員が読める。
#      同スクリプトの「見つけられないもの」に「git 履歴の走査」と書いてあった穴をここで塞ぐ。
#
#      2026-09-08 の初回走査: object store の全 blob 4,370 件・49.6 MB を走査して**ヒット 0**。
#      鍵・トークン・秘密鍵は一度も入っていない。
#      （ただし本番の project ref と organization id は履歴に残っている。秘密ではないので
#      このパターンには当たらない。棚卸しは docs/agents/data-lifecycle-inventory.md の D-032）
#
#   (a) パターンが偽の値に**当たること**を先に確かめる（0 件だから安全、と読まないため）
#   (b) object store の全オブジェクト（**到達できないものも含む**）を走査する。
#       refs から辿る `--all` より広い。消したブランチのコミットも読めるため
#   (c) 浅い clone（fetch-depth: 1）では走査にならないので**落とす**。黙って通さない
#   (d) 「コミットしてから消した」秘密を、fixture の git リポジトリで実際に作って検知できる
#   (e) 許可リスト（scripts/lib/secret-history-allowlist.txt）は**理由つきの登録だけ**効く。
#       履歴は書き換えられないので、本物でないと確かめた値はハッシュで登録して除く。
#       **いまのファイルの走査には使わない**（新しく入れようとしたものは無条件で止める）
#
# 見つけられないもの:
#   - パターンに無い独自形式のトークン、暗号化・難読化された値、分割して書かれた値
#   - **秘密ではないが出したくないもの**（project ref・組織 ID・社内 URL）。
#     秘密のパターンには当たらないので、棚卸し（D-032）と人の判断で扱う
#   - 別の clone・fork・バックアップに残った同じ履歴（こちらからは消せない）
#   - **見つけた後に消す手段は提供しない。** 履歴の書き換えは全 clone を壊すので人の判断
#
# 実行: bash scripts/check-secret-leak-history.test.sh
# 環境変数（テスト用注入ポイント）: SECRET_HISTORY_REPO
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SECRET_HISTORY_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PATTERNS_FILE="$SCRIPT_DIR/lib/secret-patterns.txt"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

PATTERNS=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  PATTERNS+=("$line")
done < "$PATTERNS_FILE"

ALLOWLIST_FILE="$SCRIPT_DIR/lib/secret-history-allowlist.txt"

# 一致した文字列が許可リストに載っているか（載っていれば 0）
# WHY: 履歴は書き換えられない（clone した全員が持っている）。本物でないと確かめたものは
#      **ハッシュで**登録して除く。いまのファイルの走査には使わない
is_allowlisted() {
  local value="$1" h
  [ -f "$ALLOWLIST_FILE" ] || return 1
  h="$(printf '%s' "$value" | shasum -a 256 | awk '{ print $1 }')"
  grep -q -E "^${h}[[:space:]]+[^[:space:]]" "$ALLOWLIST_FILE"
}

# $1=git リポジトリ。履歴に残る秘密らしい文字列を 1 行ずつ返す（空なら無し）
scan_history() {
  local repo="$1" tmp p hit
  tmp="$(mktemp -d)"
  (
    cd "$repo" || exit 1
    # 到達できないオブジェクトも含めて blob を全部取り出す
    git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' 2>/dev/null \
      | awk '$2 == "blob" { print $1 }' > "$tmp/blobs"
    git cat-file --batch < "$tmp/blobs" > "$tmp/contents" 2>/dev/null
    for p in "${PATTERNS[@]}"; do
      grep -a -o -E -- "$p" "$tmp/contents" 2>/dev/null
    done
  ) | sort -u > "$tmp/hits"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    is_allowlisted "$hit" || printf '%s\n' "$hit"
  done < "$tmp/hits"
  rm -rf "$tmp"
}

# $1=git リポジトリ。走査対象の blob 数
count_blobs() {
  git -C "$1" cat-file --batch-all-objects --batch-check='%(objecttype)' 2>/dev/null \
    | grep -c '^blob$'
}

echo "=== scenario 1: パターンが偽の値に当たる（空振り防止） ==="
# 偽の値はここで組み立てる。リテラルで書くと、このファイル自身が走査に引っかかる
A="$(printf 'a%.0s' $(seq 1 30))"
B="$(printf 'b%.0s' $(seq 1 40))"
H="$(printf '0123456789abcdef%.0s' $(seq 1 3))"
# WHY(組み立てて作る): 偽の値をリテラルで書くと、**このファイル自身が走査に引っかかる**。
#      2026-09-08 に AKIA の 1 本だけリテラルで書いてしまい、コミットした途端に
#      `check-secret-leak.test.sh` と自分自身の両方が「秘密がある」と報告した。
#      追跡されるまで気づけなかった（走査対象は `git ls-files` なので、未追跡の間は見えない）。
U="0123456789ABCDEF"
CANARIES=(
  "eyJ${A}.eyJ${B}"
  "sb_secret_${A}"
  "sbp_${H:0:40}"
  "$(printf -- '-----BEGIN %s KEY-----' 'TESTING PRIVATE')"
  "AKIA${U}"
  "ghp_${A}bcdef0123"
  "github_pat_${A}"
  "$(printf 'xox%s-0123456789-CANARY' 'b')"
  "sk-ant-${A}"
)
if [ "${#CANARIES[@]}" -ne "${#PATTERNS[@]}" ]; then
  assert_fail "パターンと偽の値の数が違う（パターンを足したら偽の値も足す）" \
    "patterns=${#PATTERNS[@]} canaries=${#CANARIES[@]}"
else
  miss=""
  for i in "${!PATTERNS[@]}"; do
    grep -q -a -E -- "${PATTERNS[$i]}" <<<"${CANARIES[$i]}" || miss="$miss
      ${PATTERNS[$i]}"
  done
  if [ -z "$miss" ]; then
    assert_ok "${#PATTERNS[@]} 本すべてが偽の値に当たる"
  else
    assert_fail "偽の値にも当たらないパターンがある（走査になっていない）" "$miss"
  fi
fi

echo "=== scenario 2: 走査対象が実在する（浅い clone では走査にならない） ==="
# worktree では .git がファイルなので、パスではなく git に聞く
if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  assert_fail "浅い clone なので履歴を走査できない" \
    "CI では actions/checkout に fetch-depth: 0 を指定する。手元では git fetch --unshallow"
else
  BLOBS="$(count_blobs "$REPO_ROOT")"
  if [ "${BLOBS:-0}" -gt 100 ]; then
    assert_ok "blob ${BLOBS} 件を走査する"
  else
    assert_fail "走査対象が少なすぎる（履歴が取れていない）" "blobs=${BLOBS}"
  fi
fi

echo "=== scenario 3: 実態の履歴に秘密が無い ==="
HITS="$(scan_history "$REPO_ROOT")"
if [ -z "$HITS" ]; then
  assert_ok "履歴に秘密らしい文字列なし"
else
  assert_fail "**履歴に秘密が残っている**（消しても clone した全員が読める。まずローテーションする）" "$HITS"
fi

echo "=== scenario 4: コミットしてから消した秘密を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$WORK" init -q
git -C "$WORK" config user.email t@example.test
git -C "$WORK" config user.name t
printf 'KEY=eyJ%s.eyJ%s\n' "$A" "$B" > "$WORK/leaked.env.example"
git -C "$WORK" add -A
git -C "$WORK" commit -q -m 'add'
rm "$WORK/leaked.env.example"
git -C "$WORK" add -A
git -C "$WORK" commit -q -m 'remove'
# いまの追跡ファイルには無い状態にしてから測る
if [ -n "$(git -C "$WORK" ls-files)" ]; then
  assert_fail "fixture の作り方が違う（消したはずのファイルが追跡されている）"
fi
FIX="$(scan_history "$WORK")"
if [ -n "$FIX" ]; then
  assert_ok "消した後でも履歴から検知する"
else
  assert_fail "コミット後に消した秘密を検知できない（履歴を見ていない）"
fi

CLEAN="$(mktemp -d)"
git -C "$CLEAN" init -q
git -C "$CLEAN" config user.email t@example.test
git -C "$CLEAN" config user.name t
printf 'const url = process.env.NEXT_PUBLIC_SUPABASE_URL\n' > "$CLEAN/ok.ts"
git -C "$CLEAN" add -A
git -C "$CLEAN" commit -q -m 'ok'
CLEANHITS="$(scan_history "$CLEAN")"
rm -rf "$CLEAN"
if [ -z "$CLEANHITS" ]; then
  assert_ok "秘密の無い履歴は誤検知しない"
else
  assert_fail "秘密が無いのに検知した" "$CLEANHITS"
fi

echo "=== scenario 5: 許可リストは「理由つきの登録」だけを許す ==="
# WHY: 許可リストは**本物の漏洩を隠す道**にもなる。ハッシュだけ書いて理由を書かない登録は
#      通さない。載っていない値は当然どおり落ちることも同時に確かめる
ALLOW_TMP="$(mktemp)"
CANARY_HASH="$(printf '%s' "AKIA${U}" | shasum -a 256 | awk '{ print $1 }')"
printf '%s\n' "$CANARY_HASH" > "$ALLOW_TMP"   # 理由なし
if ALLOWLIST_FILE="$ALLOW_TMP" is_allowlisted "AKIA${U}"; then
  assert_fail "理由の無い登録を許可リストとして受け入れた"
else
  assert_ok "理由の無い登録は効かない"
fi
printf '%s  実在しない偽の値\n' "$CANARY_HASH" > "$ALLOW_TMP"
if ALLOWLIST_FILE="$ALLOW_TMP" is_allowlisted "AKIA${U}"; then
  assert_ok "理由つきの登録は効く"
else
  assert_fail "理由つきの登録が効かない"
fi
Z="$(printf '0%.0s' $(seq 1 16))"   # ここもリテラルで書かない（走査に引っかかる）
if ALLOWLIST_FILE="$ALLOW_TMP" is_allowlisted "AKIA${Z}"; then
  assert_fail "登録していない値まで許可した"
else
  assert_ok "登録していない値は許可しない"
fi
rm -f "$ALLOW_TMP"

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
