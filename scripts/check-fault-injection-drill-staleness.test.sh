#!/bin/bash
# WHY: scripts/check-fault-injection-drill-staleness.sh(SessionStart hook)の回帰テスト。
# 実物のdocs/agents/fault-injection-drill.mdを書き換えず、テスト用の一時ファイルを
# FAULT_INJECTION_DRILL_DOC環境変数で差し替えて決定的に検証する。
#
# 実行: bash scripts/check-fault-injection-drill-staleness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-fault-injection-drill-staleness.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

future_iso() {
  python3 -c "
from datetime import date, timedelta
print((date.today() + timedelta(days=$1)).isoformat())
"
}
past_iso() {
  python3 -c "
from datetime import date, timedelta
print((date.today() - timedelta(days=$1)).isoformat())
"
}

echo "=== scenario 1: 次回実施予定日が未来 → 何も出力しない ==="
FUTURE="$(future_iso 30)"
cat > "$TMPDIR_TEST/drill-future.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 次回実施予定日

${FUTURE}（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-future.md" FAULT_INJECTION_GATE_VERSION=abc123def456 bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: 次回実施予定日が過去(期限切れ) → 警告する ==="
PAST="$(past_iso 10)"
cat > "$TMPDIR_TEST/drill-past.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 次回実施予定日

${PAST}（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-past.md" FAULT_INJECTION_GATE_VERSION=abc123def456 bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "$PAST" "期限日が含まれる"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 3: 次回実施予定日が今日ちょうど → 警告する(期限当日も対象) ==="
TODAY="$(past_iso 0)"
cat > "$TMPDIR_TEST/drill-today.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 次回実施予定日

${TODAY}（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-today.md" FAULT_INJECTION_GATE_VERSION=abc123def456 bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "当日も警告対象になる"

echo "=== scenario 4: 見出し自体が無い/日付を抽出できない → 警告する(書式崩れの検知) ==="
cat > "$TMPDIR_TEST/drill-broken.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 別の見出し

本文のみで日付が無い
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-broken.md" FAULT_INJECTION_GATE_VERSION=abc123def456 bash "$SCRIPT")"
assert_contains "$OUT" "読み取れませんでした" "書式崩れの警告が出る"

echo "=== scenario 5: ドキュメント自体が存在しない → 何も出力しない ==="
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/no-such-file.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"


echo "=== scenario 6: 門の文言が変わったのに訓練していない → 警告する（2026-09-11 追加） ==="
# WHY: それまでこの hook は**日付（四半期）しか見ていなかった**。ルール本体は
#      「Spec Check / Manifest Check 関連のプロンプトを変更したとき」にも回せと言っているのに、
#      そちらは誰も見ていなかった（undetectable-rules-inventory.md の第 3 層）。
FUTURE="$(future_iso 30)"
cat > "$TMPDIR_TEST/drill-gate-changed.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 次回実施予定日

${FUTURE}（四半期後の目安）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-gate-changed.md" FAULT_INJECTION_GATE_VERSION=999999999999 bash "$SCRIPT")"
assert_contains "$OUT" "門の文言が変わっています" "版が違えば警告する"
assert_contains "$OUT" "abc123def456" "訓練した版を出す"
assert_contains "$OUT" "999999999999" "いまの版も出す（どちらか一方では直せない）"

echo "=== scenario 7: 期限切れと版の不一致が同時 → 両方出す（潰さない。C-025） ==="
PAST="$(past_iso 10)"
cat > "$TMPDIR_TEST/drill-both.md" <<EOF
## 訓練したゲートの版

最後に訓練した版: \`abc123def456\`

## 次回実施予定日

${PAST}（四半期後の目安）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-both.md" FAULT_INJECTION_GATE_VERSION=999999999999 bash "$SCRIPT")"
assert_contains "$OUT" "$PAST" "期限切れも出る"
assert_contains "$OUT" "門の文言が変わっています" "版の不一致も同時に出る"

echo "=== scenario 8: 版の記録が無い → 「判定できない」と言う（黙って合格にしない） ==="
cat > "$TMPDIR_TEST/drill-no-version.md" <<EOF
## 次回実施予定日

${FUTURE}（四半期後の目安）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-no-version.md" FAULT_INJECTION_GATE_VERSION=abc123def456 bash "$SCRIPT")"
assert_contains "$OUT" "どの版に対する訓練だったか分からない" "版の記録が無いことを言う"

echo "=== scenario 9: 実物の走査器が版を出せる（空振り防止） ==="
# WHY(C-040): 上の scenario は注入した値で判定を測っている。**本物の走査器が動くこと**は別に測る。
#      ここが空なら、実運用では版の判定が丸ごと効いていない。
# WHY(C-048): この検査は共通側（aidd-core）として配られる。**走査器も設定も導入先には無い**のが
#      普通なので、無いことを失敗にしない（配った先で必ず赤くなる検査を配らない）。
HASHER="$SCRIPT_DIR/lib/gate-prompt-hash.mjs"
if [ ! -f "$HASHER" ] || ! command -v node >/dev/null 2>&1; then
  echo "  ➖ 対象外: 版の走査器（または node）が無い導入先"
else
  if REAL_VERSION="$(node "$HASHER" 2>/dev/null)"; then
    HASHER_STATUS=0
  else
    HASHER_STATUS=$?
  fi
  if [ "$HASHER_STATUS" -eq 2 ]; then
    echo "  ➖ 対象外: aidd.config.json に faultInjectionDrill を書いていない導入先"
  elif grep -qE '^[0-9a-f]{12}$' <<<"$REAL_VERSION"; then
    echo "  OK: 実物の門から版を数えられる（${REAL_VERSION}）"
  else
    echo "  NG: 設定はあるのに実物の門から版を数えられない（実運用では版の判定が効かない）"
    echo "      exit=${HASHER_STATUS} actual=${REAL_VERSION}"
    fail=1
  fi
fi

echo "=== scenario 10: 実態でこの hook が何を言うか ==="
# WHY: 片方だけ動いていても意味が無い。**鳴るべきときに鳴るのは scenario 6**、
#      鳴らないべきときに鳴らないのがここ。ただし期限切れ・版の不一致は**本当の警告**なので、
#      この検査を落とすのではなく内容を出す（doctor の scenario 1 と同じ扱い）。
OUT="$(bash "$SCRIPT")"
if [ -z "$OUT" ]; then
  echo "  OK: 実態では無言（期限内かつ版が一致）"
else
  echo "  注意: 実態で警告が出ている（本当の警告なのでこの検査は落とさない）"
  sed -n 's/^/      /p' <<<"$OUT" | head -5
fi

echo "=== scenario 11: 走査器が、マーカーの取り違えと不在で落ちる（fail-open 防止） ==="
# WHY(C-040): マーカーが 2 つのリテラルに当たると**別の門を数えて**しまい、
#      「版が一致した」が「正しい門を見た」を意味しなくなる。0 回なら何も見ていない。
#      どちらも黙って通さず落とす。
if [ ! -f "$HASHER" ] || ! command -v node >/dev/null 2>&1; then
  echo "  ➖ 対象外: 版の走査器（または node）が無い導入先"
else
  FX_ROOT="$TMPDIR_TEST/hasher-fx"
  mkdir -p "$FX_ROOT/.claude/workflows/lib/prompts" "$FX_ROOT/src"
  cp "$SCRIPT_DIR/../.claude/workflows/lib/prompts/extract-template-literal.js" \
     "$FX_ROOT/.claude/workflows/lib/prompts/" 2>/dev/null || true
  cat > "$FX_ROOT/src/flow.js" <<'FLOWEOF'
const a = await agent(`門A: ユニークな目印 です`)
const b = await agent(`門B: 二重の目印 です`)
const c = await agent(`別の場所にも 二重の目印 がある`)
FLOWEOF

  # 一意なマーカー → 版を出せる（対を置く。C-021）
  cat > "$FX_ROOT/aidd.config.json" <<'CFGEOF'
{ "faultInjectionDrill": { "promptSource": "src/flow.js", "gateMarkers": ["ユニークな目印"] } }
CFGEOF
  if FX_VERSION="$(node "$HASHER" --root "$FX_ROOT" 2>/dev/null)"; then FX_STATUS=0; else FX_STATUS=$?; fi
  if [ "$FX_STATUS" -eq 0 ] && grep -qE '^[0-9a-f]{12}$' <<<"$FX_VERSION"; then
    echo "  OK: 一意なマーカーなら版を出せる"
  else
    echo "  NG: 正しい fixture で版を出せない（走査器が壊れている）"
    echo "      exit=${FX_STATUS} actual=${FX_VERSION}"
    fail=1
  fi

  # 2 回出るマーカー → 落とす
  cat > "$FX_ROOT/aidd.config.json" <<'CFGEOF'
{ "faultInjectionDrill": { "promptSource": "src/flow.js", "gateMarkers": ["二重の目印"] } }
CFGEOF
  FX_ERR="$(node "$HASHER" --root "$FX_ROOT" 2>&1 >/dev/null || true)"
  if grep -q "一意でない" <<<"$FX_ERR"; then
    echo "  OK: マーカーが 2 回出れば落とす（別の門を数えない）"
  else
    echo "  NG: 取り違えを検知できない" "$FX_ERR"
    fail=1
  fi

  # 0 回のマーカー → 落とす
  cat > "$FX_ROOT/aidd.config.json" <<'CFGEOF'
{ "faultInjectionDrill": { "promptSource": "src/flow.js", "gateMarkers": ["どこにも無い目印"] } }
CFGEOF
  FX_ERR="$(node "$HASHER" --root "$FX_ROOT" 2>&1 >/dev/null || true)"
  if grep -q "マーカーが見つからない" <<<"$FX_ERR"; then
    echo "  OK: マーカーが無ければ落とす（何も見ていない状態を通さない）"
  else
    echo "  NG: マーカー不在を検知できない" "$FX_ERR"
    fail=1
  fi

  # 設定が無い導入先 → 2 で静かに降りる
  # WHY(C-044): `set -e` の下で「走らせてから $? を見る」と、非ゼロの瞬間に**この検査自身が死ぬ**
  rm -f "$FX_ROOT/aidd.config.json"
  if node "$HASHER" --root "$FX_ROOT" >/dev/null 2>&1; then
    FX_STATUS=0
  else
    FX_STATUS=$?
  fi
  if [ "$FX_STATUS" -eq 2 ]; then
    echo "  OK: 設定が無い導入先では「持たない」として降りる"
  else
    echo "  NG: 設定が無い導入先で落ちる（配った先で必ず赤くなる）"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
