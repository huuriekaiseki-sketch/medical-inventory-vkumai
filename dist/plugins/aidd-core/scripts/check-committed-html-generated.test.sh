#!/usr/bin/env bash
# WHY(2026-09-11): どこからも参照されていない古い状態ページ（docs/aidd-status.html）が
#      2.5 か月そのまま置かれていた。1 度コミットされたきり生成器も鮮度検査も無く、
#      「Generated 2026-06-25」とだけ書いてあった。開いた人には**現在の状態に見える**。
#      棚卸し（docs/agents/undetectable-rules-inventory.md）の「レビュー artifact の鮮度」の実例そのもの。
#
#      消しただけでは次の 1 枚を止められない。だから**置ける HTML の形を決める**:
#      コミットする HTML は生成物だけ。生成物であることは先頭の見出し
#        GENERATED FILE — DO NOT EDIT. Source: <元>. Regenerate: <コマンド>
#      で名乗り、名乗った元と生成器が実在し、生成器が `--check`（最新かの突合）を持つこと。
#      手で作った「その日の姿」の HTML は、見出しを名乗れないのでここで落ちる。
#
#   (a) 追跡されている *.html はすべて生成物の見出しを持つ
#   (b) 見出しが名乗る元（Source）が実在する
#   (c) 見出しが名乗る生成器（Regenerate）が実在し、`--check` を持つ
#   (d) fixture で (a)〜(c) を検知でき、正しい生成物を誤検知しない（RED 方向。C-022）
#
# 限界:
#   - 見るのは「生成物を名乗っているか」と「最新かを確かめる口があるか」まで。
#     その `--check` を**誰かが実際に回しているか**はここでは見ない
#     （回すのは各生成物の検査。例: scripts/check-aidd-graph-rendered.test.sh）。
#   - HTML 以外の置きっぱなしの成果物（画像・PDF・SVG）は見ない（実例がまだ無い）。
#   - 追跡されていない HTML（手元の計測レポート等）は見ない。コミットされないので、古びても人を欺かない。
#
# 実行: bash scripts/check-committed-html-generated.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HEADER='GENERATED FILE — DO NOT EDIT'

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=ルート、$2 以降=判定する HTML（ルート相対）→ 違反を 1 行ずつ出す（無ければ何も出さない）
check_html_files() {
  local root="$1"
  shift
  local rel header src regen
  for rel in "$@"; do
    [ -n "$rel" ] || continue
    if ! grep -qF "$HEADER" "$root/$rel" 2>/dev/null; then
      echo "    ${rel}: 生成物の見出し（${HEADER}）が無い。手で作った HTML は置けない"
      continue
    fi
    header="$(grep -m 1 -F "$HEADER" "$root/$rel")"
    src=""
    regen=""
    if [[ "$header" =~ Source:\ ([^ ]+)\.\ Regenerate: ]]; then
      src="${BASH_REMATCH[1]}"
    fi
    if [[ "$header" =~ Regenerate:\ (node\ |bash\ )?([^ ]+\.(mjs|js|sh|py)) ]]; then
      regen="${BASH_REMATCH[2]}"
    fi
    if [ -z "$src" ]; then
      echo "    ${rel}: 見出しが元（Source: <パス>.）を名乗っていない"
    elif [ ! -e "$root/$src" ]; then
      echo "    ${rel}: 見出しが名乗る元が無い（${src}）"
    fi
    if [ -z "$regen" ]; then
      echo "    ${rel}: 見出しが生成器（Regenerate: <コマンド>）を名乗っていない"
    elif [ ! -f "$root/$regen" ]; then
      echo "    ${rel}: 見出しが名乗る生成器が無い（${regen}）"
    elif ! grep -q -- '--check' "$root/$regen"; then
      echo "    ${rel}: 生成器（${regen}）に最新かを確かめる口（--check）が無い"
    fi
  done
  return 0
}

echo "=== scenario 1: 追跡されている HTML はすべて、最新かを確かめられる生成物 ==="
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  assert_fail "git の作業木として読めない（追跡中のファイルを列挙できない。走査の故障。C-044）"
else
  TRACKED="$(git -C "$REPO_ROOT" ls-files '*.html')"
  if [ -z "$TRACKED" ]; then
    # WHY(2026-09-12): 理由は言えていたが、**印の語が揃っていない**ので呼ぶ側（aidd-check）が
    #      「見た結果の合格」と「対象が無いので黙った」を区別できなかった（C-025）。
    #      「対象なし」を必ず含める、が配る検査の印の決まり。
    assert_ok "対象なし: 追跡されている HTML が 1 本も無い（この導入先は生成物の HTML を持たない）"
  else
    COUNT="$(grep -c . <<<"$TRACKED")"
    # shellcheck disable=SC2086
    VIOLATIONS="$(check_html_files "$REPO_ROOT" $TRACKED)"
    if [ -z "$VIOLATIONS" ]; then
      assert_ok "追跡されている HTML ${COUNT} 本はすべて生成物で、生成器が --check を持つ"
    else
      assert_fail "生成物を名乗れない HTML がある" "$VIOLATIONS
      直し方: 生成器から作り、先頭に「${HEADER}. Source: <元>. Regenerate: <コマンド>」を入れる。
      生成器を持たない『その日の姿』なら、コミットせずに消す（2026-09-11 の aidd-status.html と同じ扱い）"
    fi
  fi
fi

echo "=== scenario 2: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/docs" "$WORK/src" "$WORK/tools"

# 手で作ったその日の姿（見出しなし）——消した aidd-status.html と同じ形
printf '<html><body><div>Generated 2026-06-25</div></body></html>\n' > "$WORK/docs/snapshot.html"
# 元も生成器も実在し、生成器が --check を持つ（正しい）
printf 'export const graph = {}\n' > "$WORK/src/graph.mjs"
printf "if (process.argv.includes('--check')) process.exit(0)\n" > "$WORK/tools/render.mjs"
printf '<!-- %s. Source: src/graph.mjs. Regenerate: node tools/render.mjs -->\n<html></html>\n' "$HEADER" > "$WORK/docs/good.html"
# 名乗った元が無い
printf '<!-- %s. Source: src/missing.mjs. Regenerate: node tools/render.mjs -->\n' "$HEADER" > "$WORK/docs/no-source.html"
# 生成器はあるが --check が無い
printf 'export default 1\n' > "$WORK/tools/plain.mjs"
printf '<!-- %s. Source: src/graph.mjs. Regenerate: node tools/plain.mjs -->\n' "$HEADER" > "$WORK/docs/no-check.html"
# 生成器が無い
printf '<!-- %s. Source: src/graph.mjs. Regenerate: node tools/gone.mjs -->\n' "$HEADER" > "$WORK/docs/no-generator.html"

FX_OUT="$(check_html_files "$WORK" docs/snapshot.html docs/good.html docs/no-source.html docs/no-check.html docs/no-generator.html)"
if grep -q 'docs/snapshot.html: 生成物の見出し' <<<"$FX_OUT"; then
  assert_ok "手で作ったその日の姿（見出しなし）を検知"
else
  assert_fail "見出しの無い HTML を検知できない" "$FX_OUT"
fi
if grep -q 'docs/no-source.html: 見出しが名乗る元が無い' <<<"$FX_OUT"; then
  assert_ok "名乗った元が無いことを検知"
else
  assert_fail "名乗った元の欠落を検知できない" "$FX_OUT"
fi
if grep -q 'docs/no-check.html: 生成器.*--check' <<<"$FX_OUT"; then
  assert_ok "生成器に --check が無いことを検知"
else
  assert_fail "--check の欠落を検知できない" "$FX_OUT"
fi
if grep -q 'docs/no-generator.html: 見出しが名乗る生成器が無い' <<<"$FX_OUT"; then
  assert_ok "名乗った生成器が無いことを検知"
else
  assert_fail "生成器の欠落を検知できない" "$FX_OUT"
fi
if grep -q 'docs/good.html' <<<"$FX_OUT"; then
  assert_fail "正しい生成物を誤検知した" "$FX_OUT"
else
  assert_ok "正しい生成物は誤検知しない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
