#!/usr/bin/env bash
# WHY(2026-09-18、issue #783): ci.yml が `paths-ignore: docs/**` を持っていたので、**docs だけの PR では
#      CI が 1 ジョブも起動しなかった**。docs を読む検査は多数あるのに、検査が在ることと
#      起動することは別だった。PR #781（docs のみ）が違反 2 件を main へ通した実例がある。
#
#   (a) 判定（classify-changed-paths.mjs）が、docs だけ / 混在 / コードだけ を正しく分ける
#   (b) 判定できないとき（一覧が空・読めない）は **code=true**（全部回す）に倒す（C-025）
#   (c) ci.yml が paths-ignore を持たない（持てば workflow ごと起動しなくなり、(a) が無意味になる）
#   (d) **docs を見るジョブ（test / hooks-test）に起動条件が付いていない**
#   (e) docs を読むテストが実在する（= test を常に回す理由が実態として残っている。C-021 の対）
#
# 限界:
#   - ci.yml の検査は**文字列**で見るので、同じことを別の書き方（`jobs.<id>.if` を anchor で入れる等）で
#     書かれたら気づけない。GitHub の評価まで再現はしない
#   - (e) は「docs を読むテストが 1 本以上ある」までしか見ない。どのテストが何を読むかは見ない
#   - 「除外リストに足してよいか」（そのパスを読む検査が無いか）は機械で判定していない。
#     classify-changed-paths.mjs の「限界」に運用として書いてある
#
# 実行: bash scripts/check-ci-path-filter.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CLASSIFIER="$SCRIPT_DIR/lib/classify-changed-paths.mjs"
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"

command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので判定を実行できません）"
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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# $1=見出し $2=期待する code $3...=変更パス
expect_code() {
  local label="$1" want="$2"
  shift 2
  : > "$WORK/in.txt"
  for p in "$@"; do printf '%s\n' "$p" >> "$WORK/in.txt"; done
  local got
  got="$(node "$CLASSIFIER" --files "$WORK/in.txt" | sed -n 's/^code=//p')"
  if [ "$got" = "$want" ]; then
    assert_ok "${label}: code=${got}"
  else
    assert_fail "${label}: code=${got}（${want} のはず）" "$(cat "$WORK/in.txt")"
  fi
}

echo "=== scenario 1: 判定が docs だけ / 混在 / コードだけ を分ける ==="
expect_code "docs だけ" false 'docs/agents/common.md' 'docs/sessions/x.md'
expect_code "ルールブックと指示だけ" false 'CLAUDE.md' 'AGENTS.md' 'README.md' '.claude/rules/db-schema.md' '.claude/skills/a/SKILL.md'
expect_code "コードだけ" true 'src/app/page.tsx'
expect_code "docs とコードの混在" true 'docs/agents/common.md' 'src/app/page.tsx'
# WHY: scripts/ と .claude/workflows/ は hooks-test と vitest の対象。除外に紛れ込ませない
expect_code "検査スクリプト" true 'scripts/check-catalogs.test.sh'
expect_code "ワークフロー" true '.claude/workflows/aidd-phase2.js'
expect_code "CI 自身" true '.github/workflows/ci.yml'
# WHY: docs/ という語で始まるだけの別ディレクトリを巻き込まない（前方一致の境界）
expect_code "docs で始まる別のパス" true 'docsite/app.ts'

echo "=== scenario 2: 判定できないときは全部回す（C-025） ==="
expect_code "一覧が空" true
: > "$WORK/empty.txt"
if [ "$(node "$CLASSIFIER" --files "$WORK/empty.txt" | sed -n 's/^code=//p')" = "true" ]; then
  assert_ok "空ファイルでも code=true"
else
  assert_fail "空ファイルで code=false を返した（判定できないのに省いた）"
fi
if OUT="$(node "$CLASSIFIER" --files "$WORK/no-such-file.txt" 2>&1)"; then
  if grep -q '^code=true' <<<"$OUT"; then
    assert_ok "読めない一覧でも code=true で終了コード 0"
  else
    assert_fail "読めない一覧で code=true にならない" "$OUT"
  fi
else
  assert_fail "読めない一覧で異常終了した（ジョブが起動しなくなる）" "$OUT"
fi

echo "=== scenario 3: ci.yml が workflow ごと止める書き方に戻っていない ==="
if [ ! -f "$CI_YML" ]; then
  assert_ok "対象なし: この導入先に .github/workflows/ci.yml が無い"
else
  if grep -q '^ *paths-ignore:' "$CI_YML"; then
    assert_fail "ci.yml に paths-ignore が復活している（workflow ごと起動しなくなり、判定が無意味になる）" \
      "$(grep -n -A6 '^ *paths-ignore:' "$CI_YML")"
  else
    assert_ok "paths-ignore を持たない"
  fi
  if grep -qE '^ *paths:' "$CI_YML"; then
    assert_fail "ci.yml に paths: がある（paths-ignore と同じく workflow ごと止まる）" "$(grep -n -E '^ *paths:' "$CI_YML")"
  else
    assert_ok "paths: も持たない"
  fi
fi

echo "=== scenario 4: docs を見るジョブに起動条件が付いていない ==="
# WHY: ジョブ定義は「2 スペース字下げの `<id>:`」で始まり、次の同じ深さの `<id>:` までが本体。
#      その範囲に `if:` があると、docs だけの PR で起動しなくなる。
job_body() { awk -v job="  $1:" 'index($0,job)==1{f=1;next} f&&/^  [a-z-]+:$/{exit} f' "$CI_YML"; }
if [ -f "$CI_YML" ]; then
  for j in test hooks-test; do
    BODY="$(job_body "$j")"
    if [ -z "$BODY" ]; then
      assert_fail "ci.yml に ${j} ジョブが見つからない（名前が変わったならこの検査も直すこと）"
    elif grep -qE '^ *if:' <<<"$BODY"; then
      assert_fail "${j} に起動条件が付いている（docs だけの PR で回らなくなる。issue #783 の再発）" "$BODY"
    else
      assert_ok "${j} は無条件に回る"
    fi
  done
  # 逆向き（C-021 の対）: 重いジョブには条件が付いている。付いていなければ節約の意図が消えている
  for j in typecheck lint build dependency-audit; do
    BODY="$(job_body "$j")"
    if grep -q "needs.changes.outputs.code" <<<"$BODY"; then
      assert_ok "${j} は changes の判定で省ける"
    else
      assert_fail "${j} に判定が効いていない（無料枠の狙いが消えている）" "$BODY"
    fi
  done
fi

echo "=== scenario 5: docs を読むテストが実在する（test を常に回す理由の実態） ==="
# WHY(C-021): 「test を無条件に回す」は、docs を読む vitest があるからこそ要る。
#      その実態が消えたのに条件だけ残っていても、誰も気づけない。
DOC_READERS="$(grep -rl --include='*.ts' -e "docs/agents/[a-z-]*\.md'" "$REPO_ROOT/src" "$REPO_ROOT/scripts" "$REPO_ROOT/supabase" 2>/dev/null || true)"
N_READERS="$(grep -c . <<<"$DOC_READERS" || true)"
if [ ! -d "$REPO_ROOT/src" ] && [ ! -d "$REPO_ROOT/supabase" ]; then
  assert_ok "対象なし: この導入先は vitest の対象ディレクトリを持たない"
elif [ "${N_READERS:-0}" -ge 1 ]; then
  assert_ok "docs をルールブックとして読むテストが ${N_READERS} 本ある"
else
  assert_fail "docs を読むテストが 1 本も無い（test を無条件に回す理由が実態として消えている。条件の見直しどき）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
