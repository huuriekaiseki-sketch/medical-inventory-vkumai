#!/usr/bin/env bash
# WHY: 統合テストと E2E には「回したことを記録して鮮度を見る」ラッパー
#      （scripts/run-integration-tests.sh / scripts/run-e2e-tests.sh）があるのに、
#      `npm run test:integration` / `npm run test:e2e` は 2026-09-10 まで
#      vitest・playwright を直に叩いており、**普通に打つ道はハーネスを通らなかった**。
#      通らない道が残っていると、記録は空のまま「一度も回していない」と鳴り続けるか、
#      逆に赤い実行が記録に残らないまま流れる。
#      さらに `ai:check`（この 3 つを揃えて回す入口）は統合テストを含んでいなかった。
#
#      検知だけを賢くしても直らない型なので、**間違えられる道を無くしたことを固定する**。
#      新しく直に叩く script を足したら、この検査が落ちる。
#
# 実行: bash scripts/check-test-entrypoints.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# 判定本体。package.json のパスを取り、違反を1行ずつ標準出力へ出す（0行なら合格）。
# ここを関数にしているのは、実物と「わざと壊した package.json」の両方に同じ判定を掛けるため
# （通す側だけ見て終える形にしない）。
lint_package_json() {
  python3 - "$1" <<'PY'
import json, sys

WRAPPED = {
    "test:integration": "scripts/run-integration-tests.sh",
    "test:e2e": "scripts/run-e2e-tests.sh",
}
# ai:check はこれらを必ず含む（1 つのコマンドで揃えて回す入口なので、抜けると誰も回さない）
AI_CHECK_MUST_INCLUDE = ["test:integration", "test:e2e"]
# 直に叩いてはいけない実行系（ラッパー自身の中では使ってよい）
RAW = ["vitest.integration.config.ts", "playwright test"]

try:
    scripts = json.load(open(sys.argv[1]))["scripts"]
except Exception as e:
    print(f"package.json を読めません: {e}")
    sys.exit(0)

for name, wrapper in WRAPPED.items():
    cmd = scripts.get(name)
    if cmd is None:
        print(f"{name} がありません（ハーネスの入口が消えている）")
        continue
    if wrapper not in cmd:
        print(f"{name} が {wrapper} を経由していません: {cmd}")

ai_check = scripts.get("ai:check", "")
if not ai_check:
    print("ai:check がありません")
else:
    for needed in AI_CHECK_MUST_INCLUDE:
        if needed not in ai_check:
            print(f"ai:check が {needed} を含んでいません: {ai_check}")

for name, cmd in scripts.items():
    if name in WRAPPED:
        continue
    for raw in RAW:
        if raw in cmd:
            print(f"{name} が実行系を直に叩いています（{raw}）: {cmd}")
PY
}

echo "=== scenario 1: 実物の package.json が全部ハーネス経由 ==="
OUT="$(lint_package_json "$REPO_ROOT/package.json")"
if [ -z "$OUT" ]; then
  ok "違反 0 件"
else
  ng "違反がある" "$OUT"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

write_pkg() { # $1 = scripts の JSON
  printf '{"name":"t","scripts":%s}\n' "$1" > "$WORK/package.json"
}

echo "=== scenario 2: 統合テストを直に叩いていたら落ちる（元の姿） ==="
write_pkg '{"test:integration":"vitest run --config vitest.integration.config.ts","test:e2e":"bash scripts/run-e2e-tests.sh","ai:check":"npm run test:integration && npm run test:e2e"}'
OUT="$(lint_package_json "$WORK/package.json")"
case "$OUT" in
  *"test:integration が scripts/run-integration-tests.sh を経由していません"*) ok "直叩きを検知して名指しする" ;;
  *) ng "直叩きを検知できない" "$OUT" ;;
esac

echo "=== scenario 3: E2E を直に叩いていたら落ちる（元の姿） ==="
write_pkg '{"test:integration":"bash scripts/run-integration-tests.sh","test:e2e":"playwright test","ai:check":"npm run test:integration && npm run test:e2e"}'
OUT="$(lint_package_json "$WORK/package.json")"
case "$OUT" in
  *"test:e2e が scripts/run-e2e-tests.sh を経由していません"*) ok "直叩きを検知して名指しする" ;;
  *) ng "直叩きを検知できない" "$OUT" ;;
esac

echo "=== scenario 4: ai:check に統合テストが無ければ落ちる（元の姿） ==="
write_pkg '{"test:integration":"bash scripts/run-integration-tests.sh","test:e2e":"bash scripts/run-e2e-tests.sh","ai:check":"npm run test && npm run test:e2e"}'
OUT="$(lint_package_json "$WORK/package.json")"
case "$OUT" in
  *"ai:check が test:integration を含んでいません"*) ok "抜けを検知して名指しする" ;;
  *) ng "ai:check の抜けを検知できない" "$OUT" ;;
esac

echo "=== scenario 5: 別名の script で迂回しても落ちる ==="
write_pkg '{"test:integration":"bash scripts/run-integration-tests.sh","test:e2e":"bash scripts/run-e2e-tests.sh","ai:check":"npm run test:integration && npm run test:e2e","test:int2":"vitest run --config vitest.integration.config.ts"}'
OUT="$(lint_package_json "$WORK/package.json")"
case "$OUT" in
  *"test:int2 が実行系を直に叩いています"*) ok "別名の迂回路も検知する" ;;
  *) ng "別名の迂回路を検知できない" "$OUT" ;;
esac

echo "=== scenario 6: 入口そのものが消えたら落ちる（fail-open 防止） ==="
write_pkg '{"test":"vitest run"}'
OUT="$(lint_package_json "$WORK/package.json")"
case "$OUT" in
  *"test:integration がありません"*) ok "入口の消失を検知する" ;;
  *) ng "入口が消えても黙る" "$OUT" ;;
esac

echo "=== scenario 7: 正しい形なら黙る（対照） ==="
write_pkg '{"test:integration":"bash scripts/run-integration-tests.sh","test:e2e":"bash scripts/run-e2e-tests.sh","ai:check":"npm run typecheck && npm run test:integration && npm run test:e2e"}'
OUT="$(lint_package_json "$WORK/package.json")"
if [ -z "$OUT" ]; then
  ok "正しい形では何も言わない"
else
  ng "正しい形なのに鳴る（常に落ちる検査になっている）" "$OUT"
fi

echo "=== scenario 8: ラッパーが実物として存在する ==="
for w in scripts/run-integration-tests.sh scripts/run-e2e-tests.sh; do
  if [ -f "$REPO_ROOT/$w" ]; then ok "${w} がある"; else ng "${w} が無い（package.json だけ直しても回らない）"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
