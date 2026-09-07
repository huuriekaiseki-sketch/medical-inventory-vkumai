#!/bin/bash
# WHY: ロードマップの状態列が実態より古くなる事故（2026-09-07 に 5 行）を検知する
# scripts/lib/check-roadmap-staleness.mjs の構造テスト。
#
# この検査は **warning-only**（終了コードは常に 0）。「成果物が在る ＝ 終わっている」ではないので、
# 落とすと「成果物を消せば通る」という誤ったインセンティブになる。
# したがってテスト側は「出力に出るか」で判定する（終了コードでは判定できない）。
#
# 実行: bash scripts/check-roadmap-staleness.test.sh
set -uo pipefail

export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKER="$ROOT/scripts/lib/check-roadmap-staleness.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== scenario 1: 実態のロードマップに「要見直し」が無い ==="
out="$(cd "$ROOT" && node "$CHECKER" 2>&1)"
if printf '%s' "$out" | grep -q '要見直し=0'; then
  ok "要見直し 0 件"
else
  ng "状態が実態より古い行がある" "$out"
fi

echo "=== scenario 2: 成果物が在るのに「計画」の行を検知する（RED 方向の自己検証） ==="
mkdir -p "$TMP/fx/docs/agents"
cat > "$TMP/fx/docs/agents/security-test-catalog.md" <<'MD'
| 観点 | 何を確かめるか | 状態 | 引き金 |
|---|---|---|---|
| 効き目の計測 | テストが本当に守っているか | 計画 #757-7 | |
MD
# #757-7 の成果物を置く
touch "$TMP/fx/stryker.config.json"
mkdir -p "$TMP/fx/docs/agents"
touch "$TMP/fx/docs/agents/mutation-testing.md"
out="$(cd "$ROOT" && node "$CHECKER" "--root=$TMP/fx" 2>&1)"
if printf '%s' "$out" | grep -q '要見直し #757-7'; then
  ok "成果物が在る「計画」の行を検知する"
  if printf '%s' "$out" | grep -q 'stryker.config.json'; then
    ok "根拠のファイルを名指しする"
  else
    ng "根拠が出ていない" "$out"
  fi
else
  ng "検知できていない" "$out"
fi

echo "=== scenario 3: 成果物が無ければ「計画」のままでよい（誤検知しない） ==="
rm -f "$TMP/fx/stryker.config.json" "$TMP/fx/docs/agents/mutation-testing.md"
out="$(cd "$ROOT" && node "$CHECKER" "--root=$TMP/fx" 2>&1)"
if printf '%s' "$out" | grep -q '要見直し=0'; then
  ok "着手前の「計画」は誤検知しない"
else
  ng "着手前なのに要見直しと言っている" "$out"
fi

echo "=== scenario 4: warning-only（終了コードは常に 0） ==="
touch "$TMP/fx/stryker.config.json"
if (cd "$ROOT" && node "$CHECKER" "--root=$TMP/fx" >/dev/null 2>&1); then
  ok "要見直しがあっても終了コードは 0（落とさない）"
else
  ng "落としている。成果物を消せば通る形になるので warning-only にすること"
fi

echo "=== scenario 5: EVIDENCE のパスがすべて実在するか、未着手の項目である ==="
# 「終わっているのにパスが間違っていて永久に検知されない」を防ぐ。
# 未着手（ファイルがまだ無い）のは正常なので、綴り間違いと区別できない点は限界として受け入れ、
# ここでは「1 つも実在しない番号」を一覧で見せるに留める（落とさない）
missing="$(cd "$ROOT" && node -e '
import("./scripts/lib/check-roadmap-staleness.mjs").then(async (m) => {
  const fs = await import("node:fs")
  const out = []
  for (const [n, files] of Object.entries(m.EVIDENCE)) {
    if (!files.some((f) => fs.existsSync(f))) out.push(n)
  }
  console.log(out.join(","))
})')"
ok "成果物がまだ 1 つも無い番号: ${missing:-（なし）}（未着手なら正常）"

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "FAILED"
  exit 1
fi
