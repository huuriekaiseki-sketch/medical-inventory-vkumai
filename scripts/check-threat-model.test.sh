#!/bin/bash
# WHY: docs/agents/threat-model.md（脅威モデル、T-xxx。issue #757 の 22）と約束カタログ・不変条件カタログの
#      整合を機械的に固定する構造テスト。脅威モデルは「守る検査がまだ無い脅威」を見せるための上位表なので、
#   (a) 脅威モデルに書かれた P-xxx / I-xxx は各カタログに実在する（消した約束を参照し続けない）
#   (b) 各カタログの全 P-xxx / I-xxx は脅威モデルのどこかに現れる（新しい約束はどの脅威を止めるかを書く）
#   (c) 8 列・ID 規約（T-3 桁、重複なし）・状態 3 語、「未」の行は #757-N を必ず書く、
#       「守られている」の行は P-xxx / I-xxx / test-matrix の種別名のいずれかを書く
#   (d) fixture 差し替えで (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-threat-model.test.sh
# 環境変数（テスト用注入ポイント）:
#   THREAT_MODEL_PATH / PROMISE_CATALOG_PATH / INVARIANT_CATALOG_PATH / TEST_MATRIX_PATH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL="${THREAT_MODEL_PATH:-$REPO_ROOT/docs/agents/threat-model.md}"
PROMISES="${PROMISE_CATALOG_PATH:-$REPO_ROOT/docs/agents/promise-catalog.md}"
INVARIANTS="${INVARIANT_CATALOG_PATH:-$REPO_ROOT/docs/agents/invariant-catalog.md}"
MATRIX="${TEST_MATRIX_PATH:-$REPO_ROOT/docs/agents/test-matrix.md}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

catalog_ids() { grep -oE "^\| $2-[0-9]{3} " "$1" | grep -oE "$2-[0-9]{3}" | sort -u; }
model_rows() { grep '^| T-' "$1" || true; }
matrix_kinds() {
  # test-matrix の一覧の種別名（1 列目）
  awk -F'|' '/^## 一覧/{f=1; next} /^## /{f=0} f && /^\| / && $2 !~ /^ *-+ *$/ && $2 !~ /^ *種別 *$/ {gsub(/^ +| +$/,"",$2); print $2}' "$1"
}

# 検査本体。$1=脅威モデル $2=約束カタログ $3=不変条件カタログ $4=test-matrix。末尾行に violations=N
check_model() {
  local model="$1" promises="$2" invariants="$3" matrix="$4" violations=0
  local line id nf status tests seen="" ref kinds kind hit

  if [ ! -f "$model" ]; then
    echo "    missing: $model"
    echo "violations=1"
    return
  fi

  local p_ids i_ids
  p_ids="$(catalog_ids "$promises" P)"
  i_ids="$(catalog_ids "$invariants" I)"
  kinds="$(matrix_kinds "$matrix")"

  # (a) 脅威モデルが参照する ID はカタログに実在する
  for ref in $(grep -oE '[PI]-[0-9]{3}' "$model" | sort -u); do
    case "$ref" in
      P-*) printf '%s\n' "$p_ids" | grep -qx "$ref" || { echo "    stale: [$ref] 約束カタログに無い ID を参照"; violations=$((violations+1)); } ;;
      I-*) printf '%s\n' "$i_ids" | grep -qx "$ref" || { echo "    stale: [$ref] 不変条件カタログに無い ID を参照"; violations=$((violations+1)); } ;;
    esac
  done

  # (b) カタログの全 ID が脅威モデルに現れる
  for ref in $p_ids $i_ids; do
    grep -qE "(^|[^A-Za-z0-9-])${ref}([^0-9]|$)" "$model" || { echo "    uncovered: [$ref] どの脅威にも紐づいていない"; violations=$((violations+1)); }
  done

  # (c) 行の形
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    nf="$(printf '%s' "$line" | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 10 ]; then
      echo "    columns: [$id] 列数が8列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi
    if ! printf '%s' "$id" | grep -qE '^T-[0-9]{3}$'; then
      echo "    id: [$id] ID が T-3桁でない"
      violations=$((violations+1))
    fi
    if printf '%s\n' "$seen" | grep -qx "$id"; then
      echo "    id: [$id] ID が重複"
      violations=$((violations+1))
    fi
    seen="$(printf '%s\n%s' "$seen" "$id")"
    tests="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$8); print $8}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$9); print $9}')"
    case "$status" in
      守られている|一部|未) ;;
      *) echo "    status: [$id] 状態が3語以外: '$status'"; violations=$((violations+1)) ;;
    esac
    if [ "$status" = "未" ] && ! printf '%s' "$tests" | grep -qE '#757-[0-9]+'; then
      echo "    plan: [$id] 未 なのに #757-N が無い"
      violations=$((violations+1))
    fi
    if [ "$status" = "守られている" ]; then
      hit=0
      printf '%s' "$tests" | grep -qE '[PI]-[0-9]{3}' && hit=1
      if [ "$hit" -eq 0 ]; then
        while IFS= read -r kind; do
          [ -n "$kind" ] || continue
          case "$tests" in *"$kind"*) hit=1 ;; esac
        done <<< "$kinds"
      fi
      if [ "$hit" -eq 0 ]; then
        echo "    evidence: [$id] 守られている のに P-xxx / I-xxx / test-matrix の種別名が無い"
        violations=$((violations+1))
      fi
    fi
  done < <(model_rows "$model")

  echo "violations=$violations"
}

echo "=== scenario 1: 脅威モデルが存在し、脅威が1行以上ある ==="
if [ -f "$MODEL" ]; then assert_ok "存在する: $MODEL"; else assert_fail "存在しない: $MODEL"; fi
ROWS="$(model_rows "$MODEL" | wc -l | tr -d ' ')"
if [ "$ROWS" -ge 1 ]; then assert_ok "脅威 $ROWS 行"; else assert_fail "脅威が 0 行"; fi

echo "=== scenario 2: 実態の脅威モデルとカタログに違反が無い ==="
RESULT="$(check_model "$MODEL" "$PROMISES" "$INVARIANTS" "$MATRIX")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 3: fixture 差し替えで違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/promises.md" <<'EOF'
| P-900 | 使われる約束 | a | b | c | d | e | `x` | 変更時 |
| P-901 | 使われない約束 | a | b | c | d | e | `x` | 変更時 |
EOF
cat > "$WORK/invariants.md" <<'EOF'
| I-900 | 使われる不変条件 | a | b | c | `x` | 実装済み |
EOF
cat > "$WORK/matrix.md" <<'EOF'
## 一覧

| 種別 | 状態 | 実施タイミング | トリガー | 理由 | 証跡 | derive キー | 相場 | コマンド |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 秘密情報の走査 | ✅ | 毎回 | 全 PR | r | `x` | secret-scan | — | c |

## 節目のイベント
EOF
cat > "$WORK/model.md" <<'EOF'
| T-900 | 正常 | W-1 | E-1 | A-01 | RLS | P-900、I-900 | 守られている |
| T-901 | 正常（種別名） | W-1 | E-1 | A-01 | 走査 | 秘密情報の走査 | 守られている |
| T-902 | 存在しない ID | W-1 | E-1 | A-01 | x | P-999 | 一部 |
| T-903 | 未なのに計画なし | W-1 | E-1 | A-01 | x | 何も無い | 未 |
| T-904 | 守られているのに根拠なし | W-1 | E-1 | A-01 | x | 気持ち | 守られている |
| T-905 | 状態が変 | W-1 | E-1 | A-01 | x | P-900 | たぶん |
| T-900 | 重複 | W-1 | E-1 | A-01 | x | P-900 | 一部 |
| T-12 | 桁不足 | W-1 | E-1 | A-01 | x | P-900 | 一部 |
| T-906 | 列ずれ | W-1 | E-1 | A-01 | P-900 | 一部 |
EOF
RESULT="$(check_model "$WORK/model.md" "$WORK/promises.md" "$WORK/invariants.md" "$WORK/matrix.md")"
# 期待: stale P-999 / uncovered P-901 / plan T-903 / evidence T-904 / status T-905 / 重複 T-900 / 桁 T-12 / 列ずれ T-906 = 8
EXPECTED=8
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in \
  'stale: \[P-999\]' 'uncovered: \[P-901\]' 'plan: \[T-903\]' 'evidence: \[T-904\]' \
  'status: \[T-905\]' 'id: \[T-900\] ID が重複' 'id: \[T-12\]' 'columns: \[T-906\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'uncovered: \[I-900\]'; then assert_fail "紐づいている I-900 を uncovered と誤検知"; else assert_ok "紐づいている ID は uncovered にしない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
