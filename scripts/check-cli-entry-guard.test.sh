#!/bin/bash
# WHY(issue #806): 「直接起動されたときだけ main() を呼ぶ」判定を、素の文字列比較
# （import.meta.url と、argv[1] の前に file:// を付けたもの）で書くと、**symlink を含むパスで起動したときに
# 一致せず、main() が走らないまま何も出力せず exit 0 で終わる**。import.meta.url は実体パス、argv[1] は
# symlink のままのパスだからである。macOS の一時ディレクトリは symlink の下にあるので普通に踏む。
#
# 検査・走査器にとって「無出力・exit 0」は「違反なし」「漏れなし」と見分けがつかない（C-025）。
# 2026-09-20 に数えたところ、この書き方は 23 本にあり、うち 2 本だけが過去に realpath へ直されていた
# ——同じ穴を踏んで、踏んだ場所だけ直し、隣へ広げていなかった（C-047）。
# 直すだけではまた一部だけ戻るので、**素の比較の書き方そのものを落とす**。
#
# 実行: bash scripts/check-cli-entry-guard.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
# WHY(pwd -P): 一時ディレクトリ自体が symlink の下にある（macOS）。「実体パスで起動」の対照を作るために実体へ直す
WORKDIR_REAL="$(cd "$WORKDIR" && pwd -P)"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

# 走査: 素の比較（import.meta.url を argv[1] から作った file:// 文字列と比べる）を含むファイルを列挙する。
# $1=根。コメント行は数えない（この検査自身や WHY コメントが書き方を説明するため）
scan_naive_guard() {
  local root="$1"
  grep -rnE --include='*.js' --include='*.mjs' --include='*.ts' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=.git \
    'import\.meta\.url[[:space:]]*===?[[:space:]]*[`"'"'"']file://' "$root" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|#)' || true
}

echo "=== scenario 1: 素の比較は、symlink 経由で起動すると本当に黙る（型の説明を信じない） ==="
mkdir -p "$WORKDIR_REAL/real"
cat > "$WORKDIR_REAL/real/naive.mjs" <<'EOF'
function main() { console.log('ran') }
if (import.meta.url === `file://${process.argv[1]}`) { main() }
EOF
ln -s "$WORKDIR_REAL/real" "$WORKDIR_REAL/link"
OUT_REAL="$(node "$WORKDIR_REAL/real/naive.mjs")"
OUT_LINK="$(node "$WORKDIR_REAL/link/naive.mjs")"
assert_eq "$OUT_REAL" "ran" "実体パスで起動すれば main() が走る（対照）"
assert_eq "$OUT_LINK" "" "symlink 経由だと何も出力しない（偽の「何も無し」を実測）"

echo "=== scenario 2: 実態に、素の比較が 1 つも無い ==="
HITS="$(scan_naive_guard "$REPO_ROOT/scripts"; scan_naive_guard "$REPO_ROOT/.claude"; scan_naive_guard "$REPO_ROOT/e2e"; scan_naive_guard "$REPO_ROOT/src")"
if [ -z "$HITS" ]; then
  echo "  OK: 素の比較は 0 件"
else
  echo "  NG: 素の比較が残っている"
  while IFS= read -r line; do echo "      $line"; done <<<"$HITS"
  echo "      直し方: realpathSync(process.argv[1]) を pathToFileURL して import.meta.url と比べる（isRunAsCli）"
  fail=1
fi

echo "=== scenario 3: 走査が空振りしていない（C-044） ==="
SCANNED="$(find "$REPO_ROOT/scripts" "$REPO_ROOT/.claude" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.ts' \) -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
if [ "$SCANNED" -ge 50 ]; then
  echo "  OK: .js / .mjs / .ts を $SCANNED 本走査できている"
else
  echo "  NG: 走査できた本数が少なすぎる（$SCANNED 本）。走査が壊れている可能性"
  fail=1
fi
GUARDED="$(grep -rlE --include='*.js' --include='*.mjs' --include='*.ts' --exclude-dir=node_modules 'function isRunAsCli' "$REPO_ROOT/scripts" "$REPO_ROOT/.claude" | wc -l | tr -d ' ')"
if [ "$GUARDED" -ge 20 ]; then
  echo "  OK: 直した判定（isRunAsCli）を持つファイルが $GUARDED 本ある（0 件だと「書き方を変えて逃げた」を見逃す）"
else
  echo "  NG: isRunAsCli を持つファイルが $GUARDED 本しかない"
  fail=1
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
mkdir -p "$WORKDIR_REAL/fx/bad" "$WORKDIR_REAL/fx/good"
cp "$WORKDIR_REAL/real/naive.mjs" "$WORKDIR_REAL/fx/bad/a.mjs"
printf '%s\n' "if (import.meta.url == 'file://' + process.argv[1]) main()" > "$WORKDIR_REAL/fx/bad/b.js"
cat > "$WORKDIR_REAL/fx/good/ok.mjs" <<'EOF'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// 説明のためのコメント: import.meta.url === `file://${process.argv[1]}` は symlink で外れる
function isRunAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href } catch { return false }
}
if (isRunAsCli()) console.log('ran')
EOF
assert_eq "$(scan_naive_guard "$WORKDIR_REAL/fx/bad" | wc -l | tr -d ' ')" "2" "素の比較を 2 通りの書き方とも検知する"
assert_eq "$(scan_naive_guard "$WORKDIR_REAL/fx/good" | wc -l | tr -d ' ')" "0" "直した形と、コメントの中の説明は誤検知しない"
ln -s "$WORKDIR_REAL/fx/good" "$WORKDIR_REAL/fx/good-link"
assert_eq "$(node "$WORKDIR_REAL/fx/good-link/ok.mjs")" "ran" "直した形は symlink 経由でも main() が走る"

echo "=== scenario 5: 本物の gap 判定が、symlink 経由でも結果を言う ==="
ln -s "$REPO_ROOT" "$WORKDIR_REAL/repo-link"
for js in loop-observability-gap.js agent-progress-gap.js; do
  set +e
  OUT="$(node --experimental-detect-module --no-warnings "$WORKDIR_REAL/repo-link/.claude/workflows/lib/$js" --actual 1 --expected 3 2>/dev/null)"
  CODE=$?
  set -e
  assert_eq "$CODE" "1" "$js: symlink 経由でも gap ありで exit 1"
  assert_eq "$(jq -r '.hasGap' <<<"$(head -n 1 <<<"$OUT")" 2>/dev/null || echo none)" "true" "$js: symlink 経由でも hasGap を出力する"
done

echo "=== scenario 6: 判定が何も言わなかったら、呼び出し側は「漏れなし」と読まない ==="
# WHY: 判定の側をいくら直しても、将来別の理由で無出力になることはありうる。呼び出し側で
#      「出力が空 = 確かめられなかった」として非 0 にする（合格にも違反にも数えない）。
#      Stop hook（check-gap-check-state.sh）は「hasGap の出力が無く非 0」を実行失敗・未判定として扱う
mkdir -p "$WORKDIR_REAL/silent/scripts/lib" "$WORKDIR_REAL/silent/.claude/workflows/lib"
cp "$SCRIPT_DIR/check-loop-observability-gap.sh" "$SCRIPT_DIR/check-agent-progress-gap.sh" "$WORKDIR_REAL/silent/scripts/"
cp "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$SCRIPT_DIR/lib/count-flow-loop-records.sh" \
  "$SCRIPT_DIR/lib/non-subagent-loop-agents.json" "$WORKDIR_REAL/silent/scripts/lib/"
printf '%s\n' '// 何も言わずに終わる判定（無出力・exit 0）' > "$WORKDIR_REAL/silent/.claude/workflows/lib/loop-observability-gap.js"
printf '%s\n' '// 何も言わずに終わる判定（無出力・exit 0）' > "$WORKDIR_REAL/silent/.claude/workflows/lib/agent-progress-gap.js"
: > "$WORKDIR_REAL/silent/empty.jsonl"
for sh in check-loop-observability-gap.sh check-agent-progress-gap.sh; do
  set +e
  OUT="$(bash "$WORKDIR_REAL/silent/scripts/$sh" --before 0 --expected 3 --log-file "$WORKDIR_REAL/silent/empty.jsonl" 2>&1)"
  CODE=$?
  set -e
  if [ "$CODE" -ne 0 ]; then
    echo "  OK: $sh: 判定が無出力なら非 0 で終わる（exit=${CODE}）"
  else
    echo "  NG: $sh: 判定が無出力なのに exit 0（「漏れなし」と見分けがつかない）"
    fail=1
  fi
  if grep -qF "確かめられ" <<<"$OUT"; then
    echo "  OK: $sh: 確かめられなかった旨を言う"
  else
    echo "  NG: $sh: 何が起きたかを言っていない (out=$OUT)"
    fail=1
  fi
  if grep -qF "hasGap" <<<"$OUT"; then
    echo "  NG: $sh: hasGap を出力している（Stop hook が本物の判定と取り違える）"
    fail=1
  else
    echo "  OK: $sh: hasGap は出力しない（本物の判定と区別がつく）"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
