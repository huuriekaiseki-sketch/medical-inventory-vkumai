#!/bin/bash
# WHY: docs/agents/test-matrix.md（テスト一覧）と handoff-format スキルの「04 どう確認したか」
# 4値化の整合を機械的に固定する構造テスト（設計書:
# docs/superpowers/specs/2026-09-02-test-matrix-design.md）。
# kojigyo-zei-rag の codex-aidd-port.test.sh で実証した「証跡の無い ✅ を拒否する」
# 「証跡に書かれたファイルが実在する」を vkumai に移植したもの。一覧が更新されないまま
# 実態と乖離する（テストを消したのに ✅ のまま等）ことを CI の hooks-test ジョブで止める。
#
# 実行: bash scripts/check-test-matrix.test.sh
# 環境変数（テスト用注入ポイント）:
#   TEST_MATRIX_PATH   検査対象の一覧ファイル（既定 docs/agents/test-matrix.md）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MATRIX="${TEST_MATRIX_PATH:-$REPO_ROOT/docs/agents/test-matrix.md}"
SKILL="$REPO_ROOT/.claude/skills/handoff-format/SKILL.md"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 一覧の表行（先頭が "| " で、区切り行 "| ---" ではないもの）を返す。
# 列: 1=種別 2=状態 3=実施タイミング 4=トリガー 5=理由 6=証跡 7=相場 8=コマンド
matrix_rows() {
  awk -F'|' '/^\| / && $2 !~ /^ *-+ *$/ && $2 !~ /^ *種別 *$/ && NF >= 10 {print}' "$MATRIX"
}

# 検査本体。$1=一覧ファイル。NG件数を標準出力の末尾行に "violations=N" で返す。
# fixture 差し替え scenario から再利用するため関数化している。
check_matrix() {
  local file="$1" violations=0 line status timing evidence kind

  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    kind="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')"
    timing="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$4); print $4}')"
    evidence="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"

    # 1. 実施タイミングは4語 + 対象外の "—" のみ
    case "$timing" in
      毎回|変更時|節目|一度きり|—) ;;
      *) echo "    timing: [$kind] 実施タイミングが4語以外: '$timing'"; violations=$((violations+1)) ;;
    esac

    # 2. ✅ の行は証跡が空・—・未 ではない
    if printf '%s' "$status" | grep -q '✅'; then
      if [ -z "$evidence" ] || [ "$evidence" = "—" ] || printf '%s' "$evidence" | grep -q '^未'; then
        echo "    evidence: [$kind] ✅ なのに証跡が無い"
        violations=$((violations+1))
      fi
    fi

    # 3. 証跡列のバッククォート内パスが実在する（ファイルまたはディレクトリ）
    for p in $(printf '%s' "$evidence" | grep -o '`[A-Za-z0-9_./-]*`' | tr -d '`'); do
      case "$p" in
        */|*.ts|*.js|*.sh|*.md|*.yml|*.json)
          if [ ! -e "$REPO_ROOT/$p" ]; then
            echo "    path: [$kind] 証跡のパスが存在しない: $p"
            violations=$((violations+1))
          fi
          ;;
      esac
    done
  done < <(MATRIX="$file" matrix_rows)

  echo "violations=$violations"
}

echo "=== scenario 1: 一覧ファイルが存在し、表行が1行以上ある ==="
if [ -f "$MATRIX" ]; then
  assert_ok "存在する: $MATRIX"
  ROWS="$(matrix_rows | wc -l | tr -d ' ')"
  if [ "$ROWS" -ge 1 ]; then
    assert_ok "表行 ${ROWS} 行"
  else
    assert_fail "表行が0行（列数が8列でないか、表の書式が崩れている）"
  fi
else
  assert_fail "一覧ファイルが存在しない: $MATRIX"
fi

echo "=== scenario 2: 実態の一覧に違反が無い（タイミング4語・✅の証跡・証跡パスの実在） ==="
RESULT="$(check_matrix "$MATRIX")"
printf '%s\n' "$RESULT" | grep -v '^violations=' || true
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$(printf '%s\n' "$RESULT" | tail -n1)"
fi

echo "=== scenario 3: fixture 差し替えで違反を検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
FIXTURE="$WORK_DIR/bad-matrix.md"
cat > "$FIXTURE" <<'EOF'
# fixture

| 種別 | 状態 | 実施タイミング | トリガー | 理由 | 証跡 | 相場 | コマンド |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 証跡なし✅ | ✅ | 毎回 | 全PR | 理由 | — | — | `npm test` |
| 存在しないパス | ✅ | 毎回 | 全PR | 理由 | `scripts/this-file-does-not-exist.sh` | — | — |
| タイミング不正 | ⬜ 未整備 | いつか | — | 理由 | — | — | — |
| 正常行 | ✅ | 毎回 | 全PR | 理由 | `package.json` | — | `npm test` |
EOF
RESULT="$(check_matrix "$FIXTURE")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=3" ]; then
  assert_ok "違反3件（証跡なし✅・不在パス・タイミング不正）を検知"
else
  assert_fail "違反件数が期待と異なる" "$RESULT"
fi
if printf '%s\n' "$RESULT" | grep -q 'evidence: \[証跡なし✅\]'; then
  assert_ok "証跡なし✅ を検知"
else
  assert_fail "証跡なし✅ を検知できない"
fi
if printf '%s\n' "$RESULT" | grep -q 'path: \[存在しないパス\]'; then
  assert_ok "不在パスを検知"
else
  assert_fail "不在パスを検知できない"
fi
if printf '%s\n' "$RESULT" | grep -q 'timing: \[タイミング不正\]'; then
  assert_ok "タイミング不正を検知"
else
  assert_fail "タイミング不正を検知できない"
fi

echo "=== scenario 4: handoff-format スキルの 04 が4値化されている ==="
if [ -f "$SKILL" ]; then
  for needle in '✅ 実施' '➖ 今回不要' '🟡 一部' '⬜ 未実施'; do
    if grep -qF "$needle" "$SKILL"; then
      assert_ok "「$needle」がある"
    else
      assert_fail "「$needle」が無い"
    fi
  done
  if grep -qF 'test-matrix.md' "$SKILL"; then
    assert_ok "一覧へのリンクがある"
  else
    assert_fail "一覧へのリンクが無い"
  fi
else
  assert_fail "SKILL.md が存在しない: $SKILL"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
