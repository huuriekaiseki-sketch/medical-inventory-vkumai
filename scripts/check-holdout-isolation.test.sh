#!/usr/bin/env bash
# WHY(2026-09-10、C-010「人が書いた印を実態と突き合わせない」):
#      `sweep-db-holdout` の expected.json には `heldOut: true` と書いてあったが、
#      **この印を読むコードはどこにも無かった**（走査すると 1 件——宣言そのものだけ）。
#      印は書いた瞬間から実態とずれる。
#
#      held-out（評価専用の未公開セット）の意味は「プロンプトや探索手順の調整に使っていない」
#      ことにある。規律そのものは機械では測れないが、**参照が漏れていないこと**は測れる。
#
#      固定するのは 4 つ:
#        (a) 実態に違反が無い（ratchet を 0 で張る）
#        (b) 印の付け忘れ・付け間違いで落ちる
#        (c) 名前がプロンプト側へ漏れたら落ちる
#        (d) held-out が消えたら落ちる（fail-open 防止。**この検査が何も守らなくなる状態**）
#
# 実行: bash scripts/check-holdout-isolation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-holdout-isolation.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

run_scan() { # $1=fixtures root, $2=.claude 相当のディレクトリ
  SCAN_OUT="$(HOLDOUT_SCAN_FIXTURES="$1" HOLDOUT_SCAN_CLAUDE="$2" HOLDOUT_SCAN_ALLOW_ZERO="${ALLOW_ZERO:-}" node "$SCAN" 2>&1)"
  SCAN_CODE=$?
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実態に違反が無い（ratchet 0） ==="
ALLOW_ZERO= run_scan "$REPO_ROOT/scripts/eval-fixtures" "$REPO_ROOT/.claude"
if [ "$SCAN_CODE" -eq 0 ]; then ok "違反 0 件"; else ng "実態で違反が出た" "$SCAN_OUT"; fi
if grep -q "holdout-sets=[1-9]" <<<"$SCAN_OUT"; then
  ok "held-out セットを実際に見つけている（空振りでない）"
else
  ng "held-out セットが 0 件" "$SCAN_OUT"
fi
if grep -q "watched-names=[1-9]" <<<"$SCAN_OUT"; then
  ok "見張る名前を実際に取り出している"
else
  ng "見張る名前が 0 件（名前の抽出が壊れている疑い）" "$SCAN_OUT"
fi

# --- fixture のひな形 ---
mk_case() { # $1=fixtures root, $2=set, $3=case, $4=expected.json の中身, $5=fixture のファイル名
  mkdir -p "$1/$2/$3/files/src"
  printf '%s' "$4" > "$1/$2/$3/expected.json"
  echo "export const probe = 1" > "$1/$2/$3/files/src/$5"
}

GOOD="$WORK/good"
mkdir -p "$WORK/claude-empty"
# WHY(fixture の名前も業務らしくする、2026-09-10・E-070): 以前は `eval-fixture-holdout-b.ts` と
#      名付けていたが、それだと「名前に holdout が入っているから見張られる」だけになり、
#      **実態（業務らしい名前に改名した本物の fixture）と違う道を通る**（C-023）。
#      本物と同じく、名前からは評価用だと分からないものにする。
mk_case "$GOOD" "sweep-x" "case-1" '{"expectedFilePathContains":"ward-supply-list.ts","expectedKeywords":["x"]}' "ward-supply-list.ts"
mk_case "$GOOD" "sweep-x-holdout" "case-1-secret-shape" '{"heldOut":true,"expectedFilePathContains":"sterilization-record.ts","expectedKeywords":["y"]}' "sterilization-record.ts"

echo "=== scenario 2: 正しい構成なら違反 0（対照） ==="
ALLOW_ZERO= run_scan "$GOOD" "$WORK/claude-empty"
if [ "$SCAN_CODE" -eq 0 ]; then ok "正しい構成は通す"; else ng "正しい構成で落ちた" "$SCAN_OUT"; fi

echo "=== scenario 3: *-holdout なのに印が無ければ落ちる（付け忘れ） ==="
UNMARKED="$WORK/unmarked"
mk_case "$UNMARKED" "sweep-x-holdout" "case-1-secret-shape" '{"expectedFilePathContains":"sterilization-record.ts","expectedKeywords":["y"]}' "sterilization-record.ts"
ALLOW_ZERO= run_scan "$UNMARKED" "$WORK/claude-empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "印の付け忘れで落ちる"; else ng "印が無くても通した" "$SCAN_OUT"; fi
if grep -q "holdout-unmarked" <<<"$SCAN_OUT"; then
  ok "どの case かを名指しする"
else
  ng "付け忘れを名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 4: 普通のセットに印があれば落ちる（付け間違い） ==="
MISPLACED="$WORK/misplaced"
mk_case "$MISPLACED" "sweep-x" "case-1" '{"heldOut":true,"expectedFilePathContains":"ward-supply-list.ts","expectedKeywords":["x"]}' "ward-supply-list.ts"
mk_case "$MISPLACED" "sweep-x-holdout" "case-1-secret-shape" '{"heldOut":true,"expectedFilePathContains":"sterilization-record.ts","expectedKeywords":["y"]}' "sterilization-record.ts"
ALLOW_ZERO= run_scan "$MISPLACED" "$WORK/claude-empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "普通のセットの印で落ちる"; else ng "付け間違いを通した" "$SCAN_OUT"; fi
if grep -q "holdout-misplaced" <<<"$SCAN_OUT"; then
  ok "付け間違いを名指しする"
else
  ng "付け間違いを名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 5: held-out の名前がプロンプト側に出てきたら落ちる ==="
LEAKY_CLAUDE="$WORK/claude-leaky"
mkdir -p "$LEAKY_CLAUDE/agents"
cat > "$LEAKY_CLAUDE/agents/sweep-x.md" <<'MD'
---
name: sweep-x
---
探索手順: sterilization-record.ts のような形にも注意すること
MD
ALLOW_ZERO= run_scan "$GOOD" "$LEAKY_CLAUDE"
if [ "$SCAN_CODE" -ne 0 ]; then ok "プロンプトへの漏れで落ちる"; else ng "漏れを通した" "$SCAN_OUT"; fi
if grep -q "holdout-leaked" <<<"$SCAN_OUT"; then
  ok "どのファイルが触れているかを名指しする"
else
  ng "漏れを名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 5b: 普通のセットの名前が出ていても落とさない（過検知しない対照） ==="
NORMAL_CLAUDE="$WORK/claude-normal"
mkdir -p "$NORMAL_CLAUDE/agents"
cat > "$NORMAL_CLAUDE/agents/sweep-x.md" <<'MD'
---
name: sweep-x
---
探索手順: ward-supply-list.ts のような形にも注意すること
MD
ALLOW_ZERO= run_scan "$GOOD" "$NORMAL_CLAUDE"
if [ "$SCAN_CODE" -eq 0 ]; then ok "held-out でない名前は見張らない"; else ng "普通のセットの名前で落ちた" "$SCAN_OUT"; fi

echo "=== scenario 6: 走査が空振りしたら合格にしない（fail-open 防止） ==="
EMPTY="$WORK/empty"
mkdir -p "$EMPTY"
ALLOW_ZERO= run_scan "$EMPTY" "$WORK/claude-empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "セットが 0 件なら落ちる"; else ng "0 件で通した" "$SCAN_OUT"; fi
if grep -q "1 つも見つけられなかった" <<<"$SCAN_OUT"; then
  ok "走査が壊れていると言う"
else
  ng "空振りの理由を出さない" "$SCAN_OUT"
fi

NO_HOLDOUT="$WORK/no-holdout"
mk_case "$NO_HOLDOUT" "sweep-x" "case-1" '{"expectedFilePathContains":"ward-supply-list.ts","expectedKeywords":["x"]}' "ward-supply-list.ts"
ALLOW_ZERO= run_scan "$NO_HOLDOUT" "$WORK/claude-empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "held-out が消えたら落ちる（この検査が何も守らなくなる状態）"; else ng "held-out 0 件で通した" "$SCAN_OUT"; fi
ALLOW_ZERO=1 run_scan "$NO_HOLDOUT" "$WORK/claude-empty"
if [ "$SCAN_CODE" -eq 0 ]; then ok "本当に持たない導入先は環境変数で明示できる"; else ng "明示しても落ちる" "$SCAN_OUT"; fi

if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "FAILED"; fi
exit "$fail"
