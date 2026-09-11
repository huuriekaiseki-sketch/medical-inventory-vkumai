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
#   (e) **この書き方が増えない**（ratchet）。宣言していない箇所があれば落とす
#   (f) 宣言の衛生（理由が空・一度も当たらない宣言は落とす。C-049）
#   (g) fixture で (e)(f) を検知でき、直した書き方を誤検知しない（RED 方向。C-022）
#
# WHY((e) を 2026-09-11 に足した): (a)〜(d) は**機序といま動く 4 本**を測るだけで、
#      **明日書かれる 1 本**は誰も見ていなかった。E-080 で 32 ファイル 120 箇所を直したのに、
#      増えないようにする仕掛けが無い——直した日がいちばん綺麗で、あとは劣化するだけ。
#      実際、そのとき `e2e/` は走査の外で 2 本残っており、
#      `stdout-sync.mjs` の「限界」は残り 2 本と書いていた（実際は 4 本）。
#      **限界の記述のほうが間違っていた**ので、数えるのは人ではなく走査にする。
#
# 限界:
#   - 実際に動かせる CLI（無引数・`--list` 系）しか (c) では測れない。引数が要るものは対象外。
#   - (e) は行の順番で見る近似（到達しない exit も数える。走査の限界は scan-stdout-exit.mjs に）。
#
# 実行: bash scripts/check-stdout-truncation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# 免除の一覧は導入先の設定から読む（エンジンは共通側・一覧は導入先）
# shellcheck source=lib/aidd-config.sh
source "$SCRIPT_DIR/lib/aidd-config.sh"

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

# 免除の一覧は導入先のもの（エンジンは共通側）。持っていない導入先は「免除なし」で走る
EXEMPT_FILE="$WORK/exemptions.json"
aidd_config_query '.stdoutSync.exemptions // {}' '{}' "$REPO_ROOT" > "$EXEMPT_FILE"

echo "=== scenario 5: この書き方が増えていない（ratchet） ==="
SCAN_OUT="$(node "$SCRIPT_DIR/lib/scan-stdout-exit.mjs" "$REPO_ROOT" "$EXEMPT_FILE" 2>&1)"
SCANNED="$(sed -n 's/^scanned=//p' <<<"$SCAN_OUT")"
SUMMARY="$(grep '^violations=' <<<"$SCAN_OUT")"
if [ "$SUMMARY" = "violations=0 unusedExemptions=0 emptyReasons=0" ]; then
  assert_ok "宣言に無い箇所は 0 件・免除も腐っていない（${SCANNED} ファイル走査）"
else
  assert_fail "この書き方が宣言の外にある（または免除が腐っている）" "$(grep '^NG ' <<<"$SCAN_OUT" | head -10)
      直し方: scripts/lib/stdout-sync.mjs の writeLine を使う。
      使えない理由があるなら aidd.config.json の stdoutSync.exemptions に**なぜ今も要るか**を書く"
fi
if [ "${SCANNED:-0}" -ge 50 ]; then
  assert_ok "走査が空振りしていない（${SCANNED} ファイル）"
else
  assert_fail "走査できたのが ${SCANNED:-0} ファイルしかない（走査が壊れている疑い。C-044）"
fi

echo "=== scenario 6: fixture で検知できる（RED 方向の自己検証） ==="
FX="$WORK/fx"
mkdir -p "$FX/tool" "$FX/safe"
cat > "$FX/tool/bad.mjs" <<'EOF'
console.log('たくさん出す')
process.exit(1)
EOF
cat > "$FX/safe/good.mjs" <<'EOF'
import { writeLine } from '../stdout-sync.mjs'
writeLine('たくさん出す')
process.exit(1)
EOF
cat > "$FX/safe/exit-first.mjs" <<'EOF'
if (!process.argv[2]) { console.error('usage'); process.exit(1) }
console.log('出すのは最後だけ')
EOF
cat > "$FX/safe/commented.mjs" <<'EOF'
// console.log('これはコメント')
// process.exit(1)
export const x = 1
EOF

printf '{}\n' > "$WORK/empty.json"
FX_OUT="$(node "$SCRIPT_DIR/lib/scan-stdout-exit.mjs" "$FX" "$WORK/empty.json" 2>&1)"
if grep -q 'NG tool/bad.mjs' <<<"$FX_OUT"; then
  assert_ok "出してから exit する書き方を検知"
else
  assert_fail "検知できない" "$FX_OUT"
fi
if grep -q 'safe/' <<<"$FX_OUT"; then
  assert_fail "正しい書き方を誤検知した" "$FX_OUT"
else
  assert_ok "writeLine・出力より前の exit・コメントは誤検知しない"
fi

printf '{"tool/bad.mjs": "理由あり"}\n' > "$WORK/exempt-ok.json"
FX_OK="$(node "$SCRIPT_DIR/lib/scan-stdout-exit.mjs" "$FX" "$WORK/exempt-ok.json" 2>&1)"
if grep -q '^violations=0 unusedExemptions=0 emptyReasons=0$' <<<"$FX_OK"; then
  assert_ok "理由つきで宣言すれば通る"
else
  assert_fail "宣言しても通らない" "$FX_OK"
fi

printf '{"tool/bad.mjs": "  "}\n' > "$WORK/exempt-empty.json"
FX_EMPTY="$(node "$SCRIPT_DIR/lib/scan-stdout-exit.mjs" "$FX" "$WORK/exempt-empty.json" 2>&1)"
if grep -q 'の理由が空' <<<"$FX_EMPTY"; then
  assert_ok "理由が空の免除を検知"
else
  assert_fail "理由が空でも通る" "$FX_EMPTY"
fi

printf '{"tool/bad.mjs": "理由あり", "no-such-file.mjs": "理由あり"}\n' > "$WORK/exempt-stale.json"
FX_STALE="$(node "$SCRIPT_DIR/lib/scan-stdout-exit.mjs" "$FX" "$WORK/exempt-stale.json" 2>&1)"
if grep -q 'は一度も当たっていない' <<<"$FX_STALE"; then
  assert_ok "一度も当たらない免除を検知（C-049）"
else
  assert_fail "腐った免除が残せる" "$FX_STALE"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
