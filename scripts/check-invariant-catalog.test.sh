#!/bin/bash
# WHY: docs/agents/invariant-catalog.md（不変条件カタログ、I-xxx）とテストコードの整合を機械的に固定する
# 構造テスト（issue #757 の 3）。約束カタログ（scripts/check-promise-catalog.test.sh）と同じ型:
#   (a) 守るテスト列の各ファイルが実在し、その中に ID が書かれている
#   (b) テストコードにある I-xxx は必ずカタログにある（孤児 ID の禁止）
#   (c) 7 列・ID 規約・状態 3 語・「未」は「計画 / 対象外」だけ、を固定する
#
# 実行: bash scripts/check-invariant-catalog.test.sh
# 環境変数（テスト用注入ポイント）:
#   INVARIANT_CATALOG_PATH  検査対象（既定 docs/agents/invariant-catalog.md）
#   INVARIANT_TEST_ROOTS    ID を探すディレクトリ（空白区切り）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# 表の行を列に割るのはここだけ（`\|` を区切りとして数えないため。docs/agents/check-design-pitfalls.md C-047）
source "$SCRIPT_DIR/lib/table-row.sh"
CATALOG="${INVARIANT_CATALOG_PATH:-$REPO_ROOT/docs/agents/invariant-catalog.md}"
TEST_ROOTS="${INVARIANT_TEST_ROOTS:-supabase/__tests__ supabase/migrations/__tests__ src e2e}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 列: 1=ID 2=不変条件 3=守る場所 4=破る操作 5=期待 6=守るテスト 7=状態
catalog_rows() {
  grep '^| I-' "$1" || true
}

ids_in_tests() {
  local roots="$1" r
  for r in $roots; do
    [ -e "$REPO_ROOT/$r" ] || continue
    grep -rhoE 'I-[0-9]{3}' "$REPO_ROOT/$r" --include='*.test.ts' --include='*.spec.ts' --include='*.test.tsx' --include='*.test.js' --include='*.test.mjs' 2>/dev/null || true
  done | sort -u
}

check_catalog() {
  local file="$1" roots="$2" violations=0 line id nf status tests seen_ids="" p test_ids found_any

  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(table_field "$line" 2)"

    nf="$(table_nf "$line")"
    if [ "$nf" -ne 9 ]; then
      echo "    columns: [$id] 列数が7列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi

    if ! grep -qE '^I-[0-9]{3}$' <<<"$id"; then
      echo "    id: [$id] ID が I-3桁でない"
      violations=$((violations+1))
    fi
    if grep -qx "$id" <<<"$seen_ids"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen_ids="$(printf '%s\n%s' "$seen_ids" "$id")"

    tests="$(table_field "$line" 7)"
    status="$(table_field "$line" 8)"

    case "$status" in
      実装済み|計画|対象外) ;;
      *) echo "    status: [$id] 状態が3語以外: '$status'"; violations=$((violations+1)) ;;
    esac

    if [ "$tests" = "未" ]; then
      if [ "$status" = "実装済み" ]; then
        echo "    status: [$id] 守るテストが 未 なのに 実装済み"
        violations=$((violations+1))
      fi
      continue
    fi
    if [ -z "$tests" ] || [ "$tests" = "—" ]; then
      echo "    tests: [$id] 守るテストが空（無いなら 未 と書く）"
      violations=$((violations+1))
      continue
    fi
    found_any=0
    for p in $(printf '%s' "$tests" | grep -o '`[A-Za-z0-9_./-]*`' | tr -d '`'); do
      found_any=1
      if [ ! -f "$REPO_ROOT/$p" ]; then
        echo "    path: [$id] 守るテストのファイルが存在しない: $p"
        violations=$((violations+1))
        continue
      fi
      if ! grep -qF "$id" "$REPO_ROOT/$p"; then
        echo "    id-in-test: [$id] 守るテスト $p の中に ID が書かれていない"
        violations=$((violations+1))
      fi
    done
    if [ "$found_any" -eq 0 ]; then
      echo "    tests: [$id] 守るテストにバッククォートのパスが無い"
      violations=$((violations+1))
    fi
  done < <(catalog_rows "$file")

  test_ids="$(ids_in_tests "$roots")"
  for id in $test_ids; do
    if ! grep -qx "$id" <<<"$seen_ids"; then
      echo "    orphan: テストコードにあるがカタログに無い ID: $id"
      violations=$((violations+1))
    fi
  done

  echo "violations=$violations"
}

echo "=== scenario 1: カタログが存在し、不変条件が1行以上ある ==="
if [ -f "$CATALOG" ]; then
  assert_ok "存在する: $CATALOG"
  ROWS="$(catalog_rows "$CATALOG" | wc -l | tr -d ' ')"
  if [ "$ROWS" -ge 1 ]; then assert_ok "不変条件 ${ROWS} 行"; else assert_fail "不変条件が0行"; fi
else
  assert_fail "カタログが存在しない: $CATALOG"
fi

echo "=== scenario 2: 実態のカタログとテストコードに違反が無い ==="
RESULT="$(check_catalog "$CATALOG" "$TEST_ROOTS")"
grep -v '^violations=' <<<"$RESULT" || true
if [ "$(tail -n1 <<<"$RESULT")" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$(tail -n1 <<<"$RESULT")"
fi

echo "=== scenario 3: fixture 差し替えで違反を検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
FIX_ROOT="$WORK_DIR/repo"
mkdir -p "$FIX_ROOT/tests"
printf "describe('I-900 良い行', () => {})\ndescribe('I-999 孤児', () => {})\n" > "$FIX_ROOT/tests/good.test.ts"
FIXTURE="$WORK_DIR/bad-catalog.md"
cat > "$FIXTURE" <<'EOF'
| ID | 不変条件 | 守る場所 | 破る操作 | 期待 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| I-900 | 正常行 | a | b | c | `tests/good.test.ts` | 実装済み |
| I-901 | ID がテストに無い | a | b | c | `tests/good.test.ts` | 実装済み |
| I-902 | ファイル不在 | a | b | c | `tests/missing.test.ts` | 実装済み |
| I-903 | 未なのに実装済み | a | b | c | 未 | 実装済み |
| I-904 | 状態が語彙外 | a | b | c | 未 | いつか |
| I-905 | 未の計画は検査しない | a | b | c | 未 | 計画 |
| I-900 | ID 重複 | a | b | c | `tests/good.test.ts` | 実装済み |
| I-12 | ID 規約違反 | a | b | c | `tests/good.test.ts` | 実装済み |
| I-906 | 列ずれ a|b | a | b | c | `tests/good.test.ts` | 実装済み |
EOF
RESULT="$(REPO_ROOT="$FIX_ROOT" check_catalog "$FIXTURE" "tests")"
# 期待: I-901 id-in-test / I-902 path / I-903 status / I-904 status / I-900 重複 /
#       I-12 規約違反 + id-in-test / I-906 列ずれ / I-999 孤児 = 9
EXPECTED=9
if [ "$(tail -n1 <<<"$RESULT")" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（${EXPECTED}）と異なる" "$RESULT"
fi
for needle in \
  'id-in-test: \[I-901\]' 'path: \[I-902\]' 'status: \[I-903\]' 'status: \[I-904\]' \
  'id: \[I-900\] ID が重複' 'id: \[I-12\] ID が I-3桁でない' 'columns: \[I-906\]' 'orphan: .*I-999'; do
  if grep -q "$needle" <<<"$RESULT"; then
    assert_ok "検知: $needle"
  else
    assert_fail "検知できない: $needle"
  fi
done
if grep -q 'I-905' <<<"$RESULT"; then
  assert_fail "未 の計画行が検査されている（I-905）"
else
  assert_ok "未 の計画行は ID 検査を掛けない（I-905）"
fi

echo "=== scenario 4: 実態のカタログの ID は区分ごとの番号帯に収まる ==="
BAD_BAND=0
for id in $(catalog_rows "$CATALOG" | table_mask_stream | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' | table_unmask_stream); do
  case "$id" in
    I-01[0-9]|I-02[0-9]|I-03[0-9]|I-04[0-9]|I-05[0-9]|I-06[0-9]) ;;
    *) echo "    band: $id は定義済みの番号帯（01x〜06x）に無い"; BAD_BAND=1 ;;
  esac
done
if [ "$BAD_BAND" -eq 0 ]; then assert_ok "全 ID が番号帯に収まる"; else assert_fail "番号帯の外の ID がある"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
