#!/bin/bash
# WHY: docs/agents/promise-catalog.md（約束カタログ）とテストコードの整合を機械的に固定する構造テスト
# （PR③、設計書 docs/superpowers/specs/2026-09-04-promise-catalog-design.md）。
# kojigyo-zei-rag の約束カタログは「守るテスト列のファイルが存在する」しか検査せず、テスト名の
# リネームや削除に追従しない穴があった。vkumai ではテスト側に ID（P-xxx）を書き、
#   (a) カタログの各 ID が、守るテスト列に書かれた各ファイルの中に実在する
#   (b) テストコードに現れる ID は必ずカタログにある（孤児 ID の禁止）
# を双方向で検査する。ID 規約・9 列・実施タイミング 4 語・「未」行の扱いも同時に固定する。
#
# 実行: bash scripts/check-promise-catalog.test.sh
# 環境変数（テスト用注入ポイント）:
#   PROMISE_CATALOG_PATH   検査対象のカタログ（既定 docs/agents/promise-catalog.md）
#   PROMISE_TEST_ROOTS     ID を探すディレクトリ（空白区切り。既定は下記 TEST_ROOTS）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CATALOG="${PROMISE_CATALOG_PATH:-$REPO_ROOT/docs/agents/promise-catalog.md}"
TEST_ROOTS="${PROMISE_TEST_ROOTS:-supabase/__tests__ supabase/migrations/__tests__ src e2e}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# カタログの表行（先頭が "| P-" の行）。見出し・区切りは対象外。列数の条件は付けない（列ずれを違反として数える）
# 列: 1=ID 2=約束 3=Arrange 4=Act 5=Assert肯定 6=Assert否定 7=境界値 8=守るテスト 9=実施タイミング
catalog_rows() {
  grep '^| P-' "$1" || true
}

# テストコードに現れる ID（P-3桁）を重複なしで返す。$1=検索ルート（空白区切り、REPO_ROOT 相対）
ids_in_tests() {
  local roots="$1" r
  for r in $roots; do
    [ -e "$REPO_ROOT/$r" ] || continue
    grep -rhoE 'P-[0-9]{3}' "$REPO_ROOT/$r" --include='*.test.ts' --include='*.spec.ts' --include='*.test.tsx' --include='*.test.js' --include='*.test.mjs' 2>/dev/null || true
  done | sort -u
}

# 検査本体。$1=カタログ $2=検索ルート。NG 件数を末尾行 "violations=N" で返す
check_catalog() {
  local file="$1" roots="$2" violations=0 line id nf timing tests seen_ids="" p test_ids

  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"

    # 0. 9 列ちょうど（NF=11）
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 11 ]; then
      echo "    columns: [$id] 列数が9列でない（区切り数=$((nf-1))。列の中に | を含めていないか）"
      violations=$((violations+1))
      continue
    fi

    # 1. ID 規約と重複
    if ! printf '%s' "$id" | grep -qE '^P-[0-9]{3}$'; then
      echo "    id: [$id] ID が P-3桁でない"
      violations=$((violations+1))
    fi
    if printf '%s\n' "$seen_ids" | grep -qx "$id"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen_ids="$(printf '%s\n%s' "$seen_ids" "$id")"

    tests="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$9); print $9}')"
    timing="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$10); print $10}')"

    # 2. 実施タイミングは 4 語のみ
    case "$timing" in
      毎回|変更時|節目|一度きり) ;;
      *) echo "    timing: [$id] 実施タイミングが4語以外: '$timing'"; violations=$((violations+1)) ;;
    esac

    # 3. 守るテスト: 「未」か、バッククォートのパスが 1 つ以上。各パスは実在し、その中に ID が書かれている
    if [ "$tests" = "未" ]; then
      continue
    fi
    if [ -z "$tests" ] || [ "$tests" = "—" ]; then
      echo "    tests: [$id] 守るテストが空（無いなら 未 と書く）"
      violations=$((violations+1))
      continue
    fi
    local found_any=0
    for p in $(printf '%s' "$tests" | grep -o '`[A-Za-z0-9_./-]*`' | tr -d '`'); do
      found_any=1
      if [ ! -f "$REPO_ROOT/$p" ]; then
        echo "    path: [$id] 守るテストのファイルが存在しない: $p"
        violations=$((violations+1))
        continue
      fi
      if ! grep -qF "$id" "$REPO_ROOT/$p"; then
        echo "    id-in-test: [$id] 守るテスト $p の中に ID が書かれていない（テスト名に $id を含める）"
        violations=$((violations+1))
      fi
    done
    if [ "$found_any" -eq 0 ]; then
      echo "    tests: [$id] 守るテストにバッククォートのパスが無い"
      violations=$((violations+1))
    fi
  done < <(catalog_rows "$file")

  # 4. テストコードにあってカタログに無い ID（孤児）
  test_ids="$(ids_in_tests "$roots")"
  for id in $test_ids; do
    if ! printf '%s\n' "$seen_ids" | grep -qx "$id"; then
      echo "    orphan: テストコードにあるがカタログに無い ID: $id"
      violations=$((violations+1))
    fi
  done

  echo "violations=$violations"
}

echo "=== scenario 1: カタログが存在し、約束が1行以上ある ==="
if [ -f "$CATALOG" ]; then
  assert_ok "存在する: $CATALOG"
  ROWS="$(catalog_rows "$CATALOG" | wc -l | tr -d ' ')"
  if [ "$ROWS" -ge 1 ]; then assert_ok "約束 ${ROWS} 行"; else assert_fail "約束が0行"; fi
else
  assert_fail "カタログが存在しない: $CATALOG"
fi

echo "=== scenario 2: 実態のカタログとテストコードに違反が無い（ID がテストに実在・孤児なし・9列・4語） ==="
RESULT="$(check_catalog "$CATALOG" "$TEST_ROOTS")"
printf '%s\n' "$RESULT" | grep -v '^violations=' || true
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$(printf '%s\n' "$RESULT" | tail -n1)"
fi

echo "=== scenario 3: fixture 差し替えで違反を検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
FIX_ROOT="$WORK_DIR/repo"
mkdir -p "$FIX_ROOT/tests"
# fixture のテストコード: P-900 は書かれている、P-901 は書かれていない、P-999 はカタログに無い孤児
printf "describe('P-900 良い約束', () => {})\ndescribe('P-999 孤児', () => {})\n" > "$FIX_ROOT/tests/good.test.ts"
FIXTURE="$WORK_DIR/bad-catalog.md"
cat > "$FIXTURE" <<'EOF'
# fixture

| ID | 約束 | Arrange | Act | Assert（肯定） | Assert（否定） | 境界値 | 守るテスト | 実施タイミング |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-900 | 正常行 | a | b | c | d | e | `tests/good.test.ts` | 毎回 |
| P-901 | ID がテストに無い | a | b | c | d | e | `tests/good.test.ts` | 変更時 |
| P-902 | ファイル不在 | a | b | c | d | e | `tests/missing.test.ts` | 変更時 |
| P-903 | 守るテスト空 | a | b | c | d | e | — | 変更時 |
| P-904 | タイミング不正 | a | b | c | d | e | 未 | いつか |
| P-905 | 未は検査しない | a | b | c | d | e | 未 | 変更時 |
| P-900 | ID 重複 | a | b | c | d | e | `tests/good.test.ts` | 毎回 |
| P-12 | ID 規約違反 | a | b | c | d | e | `tests/good.test.ts` | 毎回 |
| P-906 | 列ずれ a|b | a | b | c | d | e | `tests/good.test.ts` | 毎回 |
EOF
# fixture では REPO_ROOT を差し替えて検査する（サブシェルで上書き）
RESULT="$(REPO_ROOT="$FIX_ROOT" check_catalog "$FIXTURE" "tests")"
# 期待: ID無し(P-901)・ファイル不在(P-902)・守るテスト空(P-903)・タイミング不正(P-904)・ID重複(P-900)・
#       ID規約違反(P-12。規約違反 +1、そのIDはテストにも無いので id-in-test +1)・列ずれ(P-906)・孤児(P-999) = 9
EXPECTED=9
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in \
  'id-in-test: \[P-901\]' 'path: \[P-902\]' 'tests: \[P-903\]' 'timing: \[P-904\]' \
  'id: \[P-900\] ID が重複' 'id: \[P-12\] ID が P-3桁でない' 'columns: \[P-906\]' 'orphan: .*P-999'; do
  if printf '%s\n' "$RESULT" | grep -q "$needle"; then
    assert_ok "検知: $needle"
  else
    assert_fail "検知できない: $needle"
  fi
done
if printf '%s\n' "$RESULT" | grep -q 'P-905'; then
  assert_fail "未 の行が検査されている（P-905）"
else
  assert_ok "未 の行は ID 検査を掛けない（P-905）"
fi

echo "=== scenario 4: 実態のカタログの ID は区分ごとの番号帯に収まる（凡例の規約） ==="
BAD_BAND=0
for id in $(catalog_rows "$CATALOG" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}'); do
  case "$id" in
    P-00[0-9]|P-01[0-9]|P-02[0-9]|P-03[0-9]|P-04[0-9]|P-05[0-9]) ;;
    *) echo "    band: $id は定義済みの番号帯（00x〜05x）に無い"; BAD_BAND=1 ;;
  esac
done
if [ "$BAD_BAND" -eq 0 ]; then assert_ok "全 ID が番号帯に収まる"; else assert_fail "番号帯の外の ID がある（区分を増やしたら凡例とこの検査を同時に更新する）"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
