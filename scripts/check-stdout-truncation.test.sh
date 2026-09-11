#!/usr/bin/env bash
# WHY(2026-09-11 に実測): Node の `console.log` は **標準出力がパイプのとき非同期**になる。
#      直後に `process.exit()` を呼ぶと、**未書き込み分がそのまま捨てられる**。
#      ファイルへ書くときは同期なので全部出る——つまり
#      **手で確かめると正しく見えて、パイプで使ったときだけ黙って切れる**（C-051）。
#
#      実測（1 行 ≒ 50 バイト）:
#        期待 100 行    → process.exit() 100     / process.exitCode 100
#        期待 1,000 行  → process.exit() 1,000   / process.exitCode 1,000
#        期待 10,000 行 → process.exit() **1,306** / process.exitCode 10,000
#        期待 100,000 行→ process.exit() **1,306** / process.exitCode 100,000
#      パイプバッファ（約 64KB）に収まるうちは起きないので、
#      **出力が育っていくにつれ、ある日から黙って切れる**。
#
#      このリポジトリで効くのは例えば `derive-test-selection --list-rules`——
#      04 表（引き継ぎメモの「どう確認したか」）の機械導出に使うもので、
#      CLAUDE.md は「自分で考えず derive の出力を貼れ」と指示している。
#      切れれば**種別の減った表を貼る**ことになる。
#
#   (a) この機序が**いま実際に起きる**ことをその場で測る（型の説明を信じない。C-010）
#   (b) 直した書き方（`process.exitCode`）では切れないことを対で測る（C-021）
#   (c) 実態の CLI が、パイプでもファイルでも同じ量を出す
#   (d) 走査が空振りしていない（対象を 1 本も見つけられなければ落とす。C-044）
#
# 限界:
#   - 実際に動かせる CLI（無引数・`--list` 系）しか測れない。引数が要るものは対象外。
#   - `console.log` 以外の出力（`process.stdout.write` の戻り値を無視する形）は見ない。
#
# 実行: bash scripts/check-stdout-truncation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: この機序がいま実際に起きる（型の説明を信じない） ==="
cat > "$WORK/exit-now.mjs" <<'EOF'
const n = Number(process.argv[2])
console.log(Array.from({ length: n }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n'))
process.exit(0)
EOF
cat > "$WORK/exit-code.mjs" <<'EOF'
const n = Number(process.argv[2])
console.log(Array.from({ length: n }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n'))
process.exitCode = 0
EOF

SMALL="$(node "$WORK/exit-now.mjs" 100 | wc -l | tr -d ' ')"
if [ "$SMALL" = "100" ]; then
  assert_ok "小さい出力（100 行）は process.exit() でも全部出る"
else
  assert_fail "小さい出力すら出ない（前提が崩れている）" "$SMALL"
fi

BIG="$(node "$WORK/exit-now.mjs" 20000 | wc -l | tr -d ' ')"
if [ "$BIG" -lt 20000 ]; then
  assert_ok "大きい出力（20,000 行）は process.exit() で切れる（${BIG} 行しか出ない）"
else
  assert_ok "この環境では切れなかった（${BIG} 行。それでも書き方は禁じる）"
fi

echo "=== scenario 2: 直した書き方では切れない（対を置く。C-021） ==="
FIXED="$(node "$WORK/exit-code.mjs" 20000 | wc -l | tr -d ' ')"
if [ "$FIXED" = "20000" ]; then
  assert_ok "process.exitCode なら 20,000 行すべて出る"
else
  assert_fail "直した書き方でも切れる（直し方が間違っている）" "$FIXED 行"
fi

echo "=== scenario 3: 実態の CLI が、パイプでもファイルでも同じ量を出す ==="
# WHY: 型の話ではなく**このリポジトリの道具が壊れていないか**を見る。
#      引数の要らないものだけを回す（回せるものが 1 本も無ければ scenario 4 が落とす）
checked=0
run_both() { # $1=ラベル / $@=コマンド
  local label="$1"; shift
  local tf tp nf np
  tf="$WORK/f.out"; tp="$WORK/p.out"
  "$@" > "$tf" 2>/dev/null
  "$@" 2>/dev/null | cat > "$tp"
  nf="$(wc -c < "$tf" | tr -d ' ')"
  np="$(wc -c < "$tp" | tr -d ' ')"
  checked=$((checked + 1))
  if [ "$nf" = "$np" ]; then
    assert_ok "${label}（${nf} バイト。ファイルとパイプが一致）"
  else
    assert_fail "${label}: パイプだと出力が変わる" "ファイル ${nf} バイト / パイプ ${np} バイト"
  fi
}

cd "$REPO_ROOT" || exit 1
[ -f scripts/derive-test-selection.sh ] && run_both "derive-test-selection --list-rules" bash scripts/derive-test-selection.sh --list-rules
[ -f scripts/derive-test-selection.sh ] && run_both "derive-test-selection --list-keys" bash scripts/derive-test-selection.sh --list-keys
[ -f scripts/lib/generate-codex-agents.mjs ] && run_both "generate-codex-agents --sections" node scripts/lib/generate-codex-agents.mjs --sections
[ -f scripts/lib/aidd-doctor.mjs ] && run_both "aidd-doctor --verbose" node scripts/lib/aidd-doctor.mjs --verbose

echo "=== scenario 4: 走査が空振りしていない（C-044） ==="
if [ "$checked" -ge 1 ]; then
  assert_ok "実態の CLI を ${checked} 本回せた"
else
  assert_fail "回せた CLI が 1 本も無い（この検査は何も見ていない）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
