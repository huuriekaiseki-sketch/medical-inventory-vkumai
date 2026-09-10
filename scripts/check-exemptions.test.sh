#!/usr/bin/env bash
# WHY(2026-09-10): このリポジトリの検査には、どれも「逃がし口」がある——
#      `// suspense-exempt: 理由` / `// skip-scope-ok: 理由` / `-- definer-open: 理由` /
#      `-- drops-guard: 理由`、それに `@ts-expect-error` と `eslint-disable`。
#      どれも理由を書かせているので 1 件ずつは納得できる形になっている。
#
#      **ところが、何個あるかを誰も数えていなかった。**
#      逃がし口は増えれば検査を形骸化させる（「ここはいつも例外だらけだから」と読まれなくなる）。
#      実測したら自作の印はすべて **0 件**だったので、**0 のうちに上限を張る**。
#
#      同時に理由の有無も見る。実測で **9 件が理由なし**だった:
#        - 1 件は走査側の過検知（すぐ上の WHY コメントに理由があった）→ 判定を直した
#        - 8 件は本物（テストの `makeChainableQuery` が any を返す理由が書いていない）→ 書いた
#
#      固定するのは 4 つ:
#        (a) 実コードが上限以内で、理由もそろっている（ratchet）
#        (b) 上限を超えたら落ちる
#        (c) 理由が無ければ落ちる／**直前のコメントに理由があれば落とさない**（過検知の対照）
#        (d) 走査が空振りしたら合格にしない（fail-open 防止）
#
# 実行: bash scripts/check-exemptions.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-exemptions.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

run_scan() { # $1=走査するディレクトリ（カンマ区切り可）, $2=台帳のパス
  SCAN_OUT="$(EXEMPTION_SCAN_ROOTS="$1" EXEMPTION_BUDGET_FILE="$2" node "$SCAN" 2>&1)"
  SCAN_CODE=$?
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BUDGET_ZERO="$WORK/budget-zero.json"
cat > "$BUDGET_ZERO" <<'JSON'
{
  "max": {
    "suspense-exempt": 0,
    "skip-scope-ok": 0,
    "definer-open": 0,
    "drops-guard": 0,
    "ts-suppress": 0,
    "eslint-disable": 0
  }
}
JSON

echo "=== scenario 1: 実コードが上限以内で、理由もそろっている（ratchet） ==="
run_scan "src,supabase,e2e" "$REPO_ROOT/scripts/lib/exemption-budget.json"
if [ "$SCAN_CODE" -eq 0 ]; then ok "違反 0 件"; else ng "実コードで違反が出た" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "files=[1-9]"; then
  ok "ファイルを実際に走査している（空振りでない）"
else
  ng "走査したファイルが 0 件" "$SCAN_OUT"
fi

echo "=== scenario 2: 上限を超えたら落ちる ==="
OVER="$WORK/over/src"
mkdir -p "$OVER"
cat > "$OVER/a.ts" <<'TS'
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 理由はある
export const x: any = 1
TS
run_scan "$WORK/over" "$BUDGET_ZERO"
if [ "$SCAN_CODE" -ne 0 ]; then ok "上限 0 に対し 1 件で落ちる"; else ng "上限を超えても通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "over-budget"; then
  ok "どの印が超えたかを名指しする"
else
  ng "超えた印を名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 3: 理由が無ければ落ちる ==="
NOREASON="$WORK/noreason/src"
mkdir -p "$NOREASON"
cat > "$NOREASON/b.ts" <<'TS'
const a = 1

// suspense-exempt:
export const y = a
TS
run_scan "$WORK/noreason" "$REPO_ROOT/scripts/lib/exemption-budget.json"
if [ "$SCAN_CODE" -ne 0 ]; then ok "理由が空なら落ちる"; else ng "理由なしで通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "missing-reason"; then
  ok "どこが理由なしかを名指しする"
else
  ng "理由なしを名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 3b: 直前のコメントに理由があれば落とさない（過検知しない対照） ==="
# WHY: 実コードにこの形があった（src/app/login/page.tsx。すぐ上の WHY に理由が書いてある）。
#      **過検知は信用を失うので高くつく**（C-024）
PREVLINE="$WORK/prevline/src"
mkdir -p "$PREVLINE"
cat > "$PREVLINE/c.ts" <<'TS'
const a = 1

// cookie の反映後にサーバー側の判定を通したいので、あえてフルリロードする
// eslint-disable-next-line @next/next/no-location-assign-relative-destination
export const y = a
TS
run_scan "$WORK/prevline" "$REPO_ROOT/scripts/lib/exemption-budget.json"
if [ "$SCAN_CODE" -eq 0 ]; then ok "直前のコメントを理由と認める"; else ng "過検知した" "$SCAN_OUT"; fi

echo "=== scenario 3c: 直前が空のコメントなら理由と認めない ==="
EMPTYCOMMENT="$WORK/emptycomment/src"
mkdir -p "$EMPTYCOMMENT"
printf 'const a = 1\n\n//\n// suspense-exempt:\nexport const y = a\n' > "$EMPTYCOMMENT/d.ts"
run_scan "$WORK/emptycomment" "$REPO_ROOT/scripts/lib/exemption-budget.json"
if [ "$SCAN_CODE" -ne 0 ]; then ok "中身の無いコメントは理由に数えない"; else ng "空のコメントで通した" "$SCAN_OUT"; fi

echo "=== scenario 4: 台帳に上限の無い印があれば落ちる（黙って増やせる状態を許さない） ==="
PARTIAL="$WORK/partial-budget.json"
cat > "$PARTIAL" <<'JSON'
{ "max": { "suspense-exempt": 0 } }
JSON
run_scan "$WORK/prevline" "$PARTIAL"
if [ "$SCAN_CODE" -ne 0 ]; then ok "上限の書き忘れで落ちる"; else ng "上限が無くても通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "missing-budget"; then
  ok "どの印の上限が無いかを名指しする"
else
  ng "上限の欠落を名指ししない" "$SCAN_OUT"
fi

echo "=== scenario 5: 走査が空振りしたら合格にしない（fail-open 防止） ==="
EMPTY="$WORK/empty"
mkdir -p "$EMPTY"
run_scan "$EMPTY" "$REPO_ROOT/scripts/lib/exemption-budget.json"
if [ "$SCAN_CODE" -ne 0 ]; then ok "ファイルが 0 件なら落ちる"; else ng "0 件で通した" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "1 つも見つけられなかった"; then
  ok "走査が壊れていると言う"
else
  ng "空振りの理由を出さない" "$SCAN_OUT"
fi

echo "=== scenario 6: 台帳が読めなければ落ちる ==="
run_scan "src" "$WORK/nope.json"
if [ "$SCAN_CODE" -ne 0 ]; then ok "台帳が無ければ落ちる"; else ng "台帳が無くても通した" "$SCAN_OUT"; fi

if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "FAILED"; fi
exit "$fail"
