#!/bin/bash
# WHY: 2026-09-04 に CI が平常時の 4〜8 倍かかった。原因は npm レジストリへの通信に依存する 2 箇所
#      （ワークフローの `npm install` による依存解決、hook スクリプトの `npx -y tsx` による毎回の
#      ダウンロード）で、レジストリが遅い日にだけ露出した。修正後に同じ書き方が戻らないよう、
#      「ワークフローに npm install が無い」「hook スクリプトが npx を実行しない」を構造テストで
#      固定する（docs/agents/known-failure-patterns.md「CI・hook が npm レジストリに毎回依存する」）。
#
# 検査:
#   1. .github/workflows/*.yml の run: に `npm install` が無い（`npm ci` を使う）
#   2. scripts/*.sh・scripts/lib/*.sh（*.test.sh を除く）にコマンドとしての `npx` が無い
#      （コメント行と、文字列内の `npx[` のような正規表現片は除く）
#   3. hook から Node 標準の型除去で直接実行される scripts/lib/*.ts の相対 import に拡張子がある
#      （拡張子が無いと node が ERR_MODULE_NOT_FOUND で落ち、hook は fail-open で沈黙する）
#
# 実行: bash scripts/check-no-registry-fetch.test.sh
# 環境変数（テスト用注入ポイント）:
#   NRF_WORKFLOWS_DIR   検査するワークフローディレクトリ（既定 .github/workflows）
#   NRF_SCRIPTS_DIR     検査するスクリプトディレクトリ（既定 scripts）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 検査本体。$1=workflows dir $2=scripts dir。違反行を出し、末尾に violations=N
check() {
  local wf="$1" sc="$2" violations=0 f hits

  # 1. workflows: run 行の npm install
  for f in "$wf"/*.yml; do
    [ -f "$f" ] || continue
    hits="$(grep -nE '^[[:space:]]*(- )?run:.*\bnpm install\b' "$f" || true)"
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | sed "s#^#    npm-install: $(basename "$f"):#"
      violations=$((violations + $(printf '%s\n' "$hits" | grep -c .)))
    fi
  done

  # 2. hook scripts: コマンドとしての npx（行頭・;・&&・|・$(・` の直後）。コメント行は除く
  for f in "$sc"/*.sh "$sc"/lib/*.sh; do
    [ -f "$f" ] || continue
    case "$f" in *.test.sh) continue ;; esac
    hits="$(grep -nE '(^|[;&|(`])[[:space:]]*npx[[:space:]]' "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | sed "s#^#    npx: $(basename "$f"):#"
      violations=$((violations + $(printf '%s\n' "$hits" | grep -c .)))
    fi
  done

  # 3. node --experimental-strip-types で実行される .ts は、その import 連鎖の相対 import に拡張子が要る
  local ts entry queue seen="" spec target
  queue="$(grep -hoE 'node [^"]*--experimental-strip-types[^"]*"[^"]+\.ts"' "$sc"/*.sh 2>/dev/null | grep -oE '"[^"]+\.ts"' | tr -d '"' | sed "s#\$SCRIPT_DIR#$sc#" | sort -u || true)"
  while [ -n "$queue" ]; do
    entry="$(printf '%s\n' "$queue" | head -n1)"
    queue="$(printf '%s\n' "$queue" | tail -n +2)"
    ts="$entry"
    [ -f "$ts" ] || ts="$REPO_ROOT/$entry"
    [ -f "$ts" ] || continue
    printf '%s\n' "$seen" | grep -qx "$ts" && continue
    seen="$(printf '%s\n%s' "$seen" "$ts")"
    for spec in $(grep -oE "from '\.\.?/[^']+'" "$ts" | sed "s/from '//; s/'\$//"); do
      case "$spec" in
        *.ts|*.js|*.mjs|*.json) target="$(dirname "$ts")/$spec"; queue="$(printf '%s\n%s' "$queue" "$target")" ;;
        *)
          echo "    ts-import: $(basename "$ts") の相対 import に拡張子が無い: $spec（node 直接実行で解決できない）"
          violations=$((violations+1))
          ;;
      esac
    done
  done

  echo "violations=$violations"
}

echo "=== scenario 1: 実態のワークフロー・スクリプトに違反が無い ==="
RESULT="$(check "${NRF_WORKFLOWS_DIR:-$REPO_ROOT/.github/workflows}" "${NRF_SCRIPTS_DIR:-$REPO_ROOT/scripts}")"
printf '%s\n' "$RESULT" | grep -v '^violations=' || true
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$(printf '%s\n' "$RESULT" | tail -n1)"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/wf" "$WORK_DIR/sc/lib"
cat > "$WORK_DIR/wf/bad.yml" <<'EOF'
jobs:
  x:
    steps:
      - run: npm install
      - run: npm ci
      - run: npx playwright install --with-deps chromium
EOF
cat > "$WORK_DIR/sc/bad-hook.sh" <<'EOF'
#!/bin/bash
# npx tsx をコメントで書いても違反ではない
PATTERN='^(npx[[:space:]]+)?supabase'
npx -y tsx "$SCRIPT_DIR/lib/thing.ts"
OUT="$(npx something)"
node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/entry.ts"
EOF
cat > "$WORK_DIR/sc/bad-hook.test.sh" <<'EOF'
npx -y tsx should-be-ignored-in-tests
EOF
printf "import { a } from './dep.ts'\nimport { b } from './noext'\n" > "$WORK_DIR/sc/lib/entry.ts"
printf "export const a = 1\n" > "$WORK_DIR/sc/lib/dep.ts"
RESULT="$(check "$WORK_DIR/wf" "$WORK_DIR/sc")"
# 期待: npm install 1 + npx 2（npx -y tsx、$(npx something)）+ 拡張子なし import 1 = 4
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=4" ]; then
  assert_ok "違反 4 件をちょうど検知"
else
  assert_fail "違反件数が期待（4）と異なる" "$RESULT"
fi
for needle in 'npm-install: bad.yml' 'npx: bad-hook.sh:4' 'npx: bad-hook.sh:5' "ts-import: entry.ts"; do
  if printf '%s\n' "$RESULT" | grep -qF "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
for needle in 'npm ci' 'playwright' 'bad-hook.test.sh' 'PATTERN'; do
  if printf '%s\n' "$RESULT" | grep -qF "$needle"; then assert_fail "誤検知: $needle"; else assert_ok "誤検知しない: $needle"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
