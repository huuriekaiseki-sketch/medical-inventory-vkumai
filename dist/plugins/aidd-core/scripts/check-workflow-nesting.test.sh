#!/usr/bin/env bash
# WHY(2026-09-12): Workflow の入れ子は 1 段まで。2 段目を呼ぶと、エージェントを 1 体も起動しないまま
#      「workflow() cannot be called from within a child workflow」で失敗する（実測）。
#
#      中心リポジトリの形（セッション → router → phase1）は 1 段で収まるのに、
#      **配布物の形**（導入先の wrapper → router → phase1）は 2 段になる。
#      2026-09-12 の導入先 fixture で回すまで、**導入先の入口が一度も動いていなかった**（E-085・C-053）。
#      同じ形に戻れないよう、連鎖そのものを門にする。
#
#   (a) 実態（中心リポジトリ・導入先ひな形・生成物）に 2 段の連鎖が無い
#   (b) 走査が空振りしていない（Workflow を 1 本も見つけられなければ落とす。C-025）
#   (c) fixture で 2 段を検知でき、1 段は誤検知しない（RED 方向の自己検証。C-022）
#   (d) 導入先ひな形に Workflow を置いていない（置けば必ず 2 段になるため。E-085 の再発防止）
#
# 限界: 見るのは**静的な呼び出しの形**だけ。実行時に本当に落ちることは
#       `scripts/workflow-nesting-drill.sh`（本物の Workflow 実行）が測る。対で持つ。
#
# 実行: bash scripts/check-workflow-nesting.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(導入先のルートを先に見る): 配られると、この検査は配布物の中にある。
#      `$SCRIPT_DIR/..` を使うと配布物を導入先だと思い込む（check-pitfall-rulebook と同じ）
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
SCANNER="$SCRIPT_DIR/lib/scan-workflow-nesting.mjs"
TEMPLATE_WORKFLOWS="$REPO_ROOT/docs/plugin/templates/consumer/.claude/workflows"

# WHY(2026-09-12): node が無い導入先で回すと、走査器が 127 で落ち、この検査は
#      **「2 段の入れ子がある」と存在しない違反を報告した**（実測）。導入先は無い問題を
#      追いかけることになる。確かめられなかっただけなので、合格にも違反にも数えさせない。
command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので Workflow の連鎖を走査できない。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

if [ ! -f "$SCANNER" ]; then
  echo "  NG: 走査器が無い: $SCANNER"
  echo "FAILED"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# $1=置き場 $2=Workflow 名 $3=呼ぶ相手（空なら呼ばない）
make_workflow() {
  local dir="$1" name="$2" calls="${3:-}"
  mkdir -p "$dir"
  {
    echo "export const meta = {"
    echo "  name: '${name}',"
    echo "  description: 'fixture',"
    echo "}"
    if [ -n "$calls" ]; then
      echo "return await workflow('${calls}', {})"
    else
      echo "return { ok: true }"
    fi
  } > "$dir/${name}.js"
}

run_scan() {
  node "$SCANNER" --root "$1" 2>&1
}

echo "=== scenario 1: 実態に 2 段の連鎖が無い ==="
OUT="$(run_scan "$REPO_ROOT")"
RC=$?
if [ "$RC" -eq 0 ]; then
  assert_ok "2 段の入れ子なし（$(head -1 <<<"$OUT")）"
elif [ "$RC" -eq 2 ] && [ ! -d "$REPO_ROOT/.claude/workflows" ]; then
  # WHY(2026-09-12): 配った先が Workflow を持つとは限らない。持っていない導入先で
  #      「走査が壊れている」と赤くするのは意味が無い（E-086）。置き場ごと無ければ対象なし。
  assert_ok "この導入先には Workflow が無いので対象なし"
elif [ "$RC" -eq 2 ]; then
  assert_fail "走査できなかった（置き場はあるのに Workflow を 1 本も見つけられない）" "$OUT"
else
  assert_fail "2 段の入れ子がある" "$OUT"
fi

echo "=== scenario 2: 走査が空振りしていない（C-025） ==="
SCANNED="$(sed -n 's/^Workflow \([0-9][0-9]*\) 本を走査しました$/\1/p' <<<"$OUT")"
if [ ! -d "$REPO_ROOT/.claude/workflows" ]; then
  assert_ok "Workflow の置き場が無い導入先なので対象なし"
elif [ -n "$SCANNED" ] && [ "$SCANNED" -ge 1 ]; then
  assert_ok "${SCANNED} 本を走査できている"
else
  assert_fail "置き場はあるのに走査できたのが ${SCANNED:-0} 本（走査先が変わった疑い）" "$OUT"
fi

echo "=== scenario 3: fixture で 2 段を検知する（RED 方向） ==="
BAD="$WORK/bad"
make_workflow "$BAD/.claude/workflows" wrapper router
make_workflow "$BAD/.claude/workflows" router phase1
make_workflow "$BAD/.claude/workflows" phase1 ""
OUT_BAD="$(run_scan "$BAD")"
RC_BAD=$?
if [ "$RC_BAD" -eq 1 ] && grep -q 'wrapper -> router -> phase1' <<<"$OUT_BAD"; then
  assert_ok "2 段の連鎖を名指しで検知する"
else
  assert_fail "2 段の連鎖を検知できない（終了コード ${RC_BAD}）" "$OUT_BAD"
fi

echo "=== scenario 4: 1 段は誤検知しない ==="
GOOD="$WORK/good"
make_workflow "$GOOD/.claude/workflows" router phase1
make_workflow "$GOOD/.claude/workflows" phase1 ""
OUT_GOOD="$(run_scan "$GOOD")"
RC_GOOD=$?
if [ "$RC_GOOD" -eq 0 ]; then
  assert_ok "1 段（router -> phase1）は通す"
else
  assert_fail "1 段を誤検知した（終了コード ${RC_GOOD}）" "$OUT_GOOD"
fi

echo "=== scenario 5: 修飾名でも連鎖をたどる（配布物の形） ==="
DIST="$WORK/dist"
make_workflow "$DIST/docs/plugin/templates/consumer/.claude/workflows" phase1-router "aidd-adapter:phase1-router"
make_workflow "$DIST/dist/plugins/aidd-adapter/workflows" phase1-router "aidd-adapter:phase1"
make_workflow "$DIST/dist/plugins/aidd-adapter/workflows" phase1 ""
OUT_DIST="$(run_scan "$DIST")"
RC_DIST=$?
if [ "$RC_DIST" -eq 1 ] && grep -q 'aidd-adapter:phase1-router -> aidd-adapter:phase1' <<<"$OUT_DIST"; then
  assert_ok "ひな形 → プラグインの連鎖も検知する（2026-09-12 に実際に踏んだ形）"
else
  assert_fail "修飾名をまたぐ連鎖を検知できない（終了コード ${RC_DIST}）" "$OUT_DIST"
fi

echo "=== scenario 6: 走査できなければ緑にしない（fail-open 防止） ==="
EMPTY="$WORK/empty"
mkdir -p "$EMPTY"
OUT_EMPTY="$(run_scan "$EMPTY")"
RC_EMPTY=$?
if [ "$RC_EMPTY" -eq 2 ]; then
  assert_ok "Workflow が 1 本も無ければ 2（合格とも不合格とも言わない）"
else
  assert_fail "空の走査を合格にした（終了コード ${RC_EMPTY}）" "$OUT_EMPTY"
fi

echo "=== scenario 7: 導入先ひな形に Workflow を置いていない（E-085 の再発防止） ==="
if [ -d "$TEMPLATE_WORKFLOWS" ]; then
  FOUND="$(find "$TEMPLATE_WORKFLOWS" -maxdepth 1 -name '*.js' -type f)"
  if [ -z "$FOUND" ]; then
    assert_ok "ひな形に Workflow が無い（導入先は修飾名で直接呼ぶ）"
  else
    assert_fail "ひな形に Workflow がある（wrapper を置くと必ず 2 段になる）" "$FOUND"
  fi
else
  assert_ok "ひな形に Workflow のディレクトリ自体が無い"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
