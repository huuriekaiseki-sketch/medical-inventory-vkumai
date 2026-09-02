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

# 一覧の表行（"## 一覧" セクション内で、先頭が "| " で、区切り行 "| ---" と見出し行ではないもの）を返す。
# 「節目のイベント」等の別セクションの表は対象外。列数の条件は付けない（列ずれ行を無言で
# 落とさず、check_matrix 側で違反として数えるため）。
# 列: 1=種別 2=状態 3=実施タイミング 4=トリガー 5=理由 6=証跡 7=相場 8=コマンド
matrix_rows() {
  awk -F'|' '/^## 一覧/{f=1; next} /^## /{f=0} f && /^\| / && $2 !~ /^ *-+ *$/ && $2 !~ /^ *種別 *$/ {print}' "$MATRIX"
}

# .github/workflows/*.yml の jobs: 直下のジョブ名を全て返す（証跡列の「CI `xxx` ジョブ」の実在検査用）。
# on: 配下の pull_request: 等を拾わないよう、jobs: 行からトップレベルの次のキーまでだけを見る。
ci_job_names() {
  awk '/^jobs:/{f=1; next} /^[^ ]/{f=0} f && /^  [a-z][a-z0-9_-]*:$/{sub(/^  /,""); sub(/:$/,""); print}' \
    "$REPO_ROOT"/.github/workflows/*.yml | sort -u
}

# 検査本体。$1=一覧ファイル。NG件数を標準出力の末尾行に "violations=N" で返す。
# fixture 差し替え scenario から再利用するため関数化している。
check_matrix() {
  local file="$1" violations=0 line status timing reason evidence kind nf job jobs

  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi

  jobs="$(ci_job_names)"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    kind="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"

    # 0. 列数は8列（区切り "|" で分けると先頭・末尾の空を含めて NF=10）ちょうど。
    #    理由や証跡に "|" を含めると列がずれ、以降の検査が別の列を見てしまうため、
    #    ずれた行は無言で落とさず違反として数える
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 10 ]; then
      echo "    columns: [$kind] 列数が8列でない（区切り数=$((nf-1))。理由・証跡に | を含めていないか）"
      violations=$((violations+1))
      continue
    fi

    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')"
    timing="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$4); print $4}')"
    reason="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$6); print $6}')"
    evidence="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"

    # 0b. ✅ 以外（➖ / 🟡 / ⬜）の行は理由列が必須（凡例の「理由必須」を機械で守る）
    if ! printf '%s' "$status" | grep -q '✅'; then
      if [ -z "$reason" ] || [ "$reason" = "—" ]; then
        echo "    reason: [$kind] 状態 '$status' なのに理由列が空"
        violations=$((violations+1))
      fi
    fi

    # 0c. 証跡列の「CI `xxx` ジョブ」は .github/workflows/*.yml の jobs: に実在する
    for job in $(printf '%s' "$evidence" | grep -o 'CI `[a-z][a-z0-9_-]*` ジョブ' | sed 's/CI `\(.*\)` ジョブ/\1/'); do
      if ! printf '%s\n' "$jobs" | grep -qx "$job"; then
        echo "    job: [$kind] 証跡の CI ジョブが存在しない: $job"
        violations=$((violations+1))
      fi
    done

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

## 一覧

| 種別 | 状態 | 実施タイミング | トリガー | 理由 | 証跡 | 相場 | コマンド |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 証跡なし✅ | ✅ | 毎回 | 全PR | 理由 | — | — | `npm test` |
| 存在しないパス | ✅ | 毎回 | 全PR | 理由 | `scripts/this-file-does-not-exist.sh` | — | — |
| タイミング不正 | ⬜ 未整備 | いつか | — | 理由 | — | — | — |
| CIジョブ不在 | ✅ | 毎回 | 全PR | 理由 | CI `no-such-job` ジョブ（`package.json`） | — | — |
| 理由なし➖ | ➖ | — | — | — | — | — | — |
| 列ずれ | ✅ | 毎回 | 全PR | 理由 a|b | `package.json` | — | — |
| 正常行 | ✅ | 毎回 | 全PR | 理由 | `package.json` | — | `npm test` |
| 正常🟡 | 🟡 | 変更時 | 何か | 欠けている点 | `package.json` | — | — |

## 節目のイベント

| イベント | 実施する種別 |
| --- | --- |
| 別セクションの2列表 | 検査対象外であること |
EOF
RESULT="$(check_matrix "$FIXTURE")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=6" ]; then
  assert_ok "違反6件（証跡なし✅・不在パス・タイミング不正・CIジョブ不在・理由なし・列ずれ）をちょうど検知"
else
  assert_fail "違反件数が期待と異なる" "$RESULT"
fi
if printf '%s\n' "$RESULT" | grep -q 'job: \[CIジョブ不在\]'; then
  assert_ok "CIジョブ不在を検知"
else
  assert_fail "CIジョブ不在を検知できない"
fi
if printf '%s\n' "$RESULT" | grep -q 'reason: \[理由なし➖\]'; then
  assert_ok "理由なし➖ を検知"
else
  assert_fail "理由なし➖ を検知できない"
fi
if printf '%s\n' "$RESULT" | grep -q 'columns: \[列ずれ\]'; then
  assert_ok "列ずれを検知"
else
  assert_fail "列ずれを検知できない"
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
