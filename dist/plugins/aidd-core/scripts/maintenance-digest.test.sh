#!/bin/bash
# WHY: scripts/maintenance-digest.sh（Setup hook、matcher maintenance。issue #741）の回帰テスト。
# 実物のランブック 5 本を書き換えず、環境変数で一時ファイルへ差し替えて決定的に検証する。
# あわせて .claude/settings.json に Setup(maintenance) の登録があることを検査する
# （settings 側の登録が落ちるとダイジェスト自体が呼ばれなくなるため）。
#
# 実行: bash scripts/maintenance-digest.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を導入先だと思い込む（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
SCRIPT="$SCRIPT_DIR/maintenance-digest.sh"
SETTINGS="$REPO_ROOT/.claude/settings.json"

# 導入先が settings.json とランブックを持っていなければ、この検査は見るものが無い。
# 持っていないだけで赤くしない（E-086）
if [ ! -f "$SETTINGS" ]; then
  echo "=== scenario 0: この導入先には .claude/settings.json が無い ==="
  echo "  SKIP: 登録を確かめる相手が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }
not_contains() { if grep -qF -- "$2" <<<"$1"; then ng "$3" "unexpected: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
iso_offset() { python3 -c "from datetime import date, timedelta; print((date.today() + timedelta(days=$1)).isoformat())"; }
write_doc() { printf '# x\n\n## 次回実施予定日\n\n%s（目安）\n' "$2" > "$1"; }

run_digest() {
  set +e
  OUT="$(FAULT_INJECTION_DRILL_DOC="$WORK/fi.md" HOOK_LIVE_DRILL_DOC="$WORK/hl.md" UPSTREAM_DOCS_REVIEW_DOC="$WORK/ud.md" DEPENDENCY_UPDATE_DOC="$WORK/du.md" ACCESS_REVIEW_DOC="$WORK/ar.md" MUTATION_TESTING_DOC="$WORK/mt.md" RLS_MUTATION_DOC="$WORK/rm.md" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: 7 本とも期限前 → 超過なしのダイジェスト（次の期限一覧） ==="
write_doc "$WORK/fi.md" "$(iso_offset 30)"
write_doc "$WORK/hl.md" "$(iso_offset 60)"
write_doc "$WORK/ud.md" "$(iso_offset 10)"
write_doc "$WORK/du.md" "$(iso_offset 20)"
write_doc "$WORK/ar.md" "$(iso_offset 90)"
write_doc "$WORK/mt.md" "$(iso_offset 45)"
write_doc "$WORK/rm.md" "$(iso_offset 91)"
run_digest
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "exit $EXIT_CODE"
contains "$OUT" "systemMessage" "Setup hook の JSON を返す"
contains "$OUT" '"hookEventName": "Setup"' "hookEventName が Setup"
contains "$OUT" "期限超過なし" "超過なしの要約"
contains "$OUT" "fault injection 訓練: 期限 $(iso_offset 30)" "各作業の次の期限を出す"
contains "$OUT" "依存の月次棚卸し: 期限 $(iso_offset 20)" "依存の棚卸し（4 つ目、issue #757 の 21）も出す"
contains "$OUT" "鍵・権限の四半期棚卸し: 期限 $(iso_offset 90)" "鍵・権限の棚卸し（5 つ目、issue #757 の 36）も出す"
contains "$OUT" "あと 10 日" "残り日数を出す"

echo "=== scenario 2: 1 本が期限超過 → ⚠ と超過件数、手順への参照 ==="
write_doc "$WORK/hl.md" "$(iso_offset -5)"
run_digest
contains "$OUT" "hook 実走ドリル: ⚠ 期限 $(iso_offset -5) を 5 日超過" "超過した作業を ⚠ 付きで出す"
contains "$OUT" "期限超過 1 件" "超過件数を要約に出す"
contains "$OUT" "hook-live-drill.md" "手順への参照を出す"
not_contains "$OUT" "fault injection 訓練: ⚠" "期限前の作業には ⚠ を付けない"

echo "=== scenario 3: 日付が読めないランブック → その旨を出し、他の判定は続ける ==="
printf '# x\n\n本文のみ\n' > "$WORK/fi.md"
run_digest
contains "$OUT" "fault injection 訓練: 「## 次回実施予定日」から日付を読み取れません" "書式崩れを名指し"
contains "$OUT" "公式 docs 差分確認: 期限" "他の作業の判定は続く"

echo "=== scenario 4: ランブック不在 → その旨を出し、exit 0 ==="
rm -f "$WORK/ud.md"
run_digest
contains "$OUT" "公式 docs 差分確認: ランブックが見つかりません" "不在を名指し"
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0（block しない）" || ng "exit $EXIT_CODE"

echo "=== scenario 5: MAINTENANCE_DIGEST_PLAIN=1 → JSON でなく素のテキスト ==="
PLAIN="$(FAULT_INJECTION_DRILL_DOC="$WORK/fi.md" HOOK_LIVE_DRILL_DOC="$WORK/hl.md" UPSTREAM_DOCS_REVIEW_DOC="$WORK/ud.md" DEPENDENCY_UPDATE_DOC="$WORK/du.md" ACCESS_REVIEW_DOC="$WORK/ar.md" MUTATION_TESTING_DOC="$WORK/mt.md" RLS_MUTATION_DOC="$WORK/rm.md" MAINTENANCE_DIGEST_PLAIN=1 bash "$SCRIPT" < /dev/null)"
not_contains "$PLAIN" "systemMessage" "素のテキストには JSON キーが無い"
contains "$PLAIN" "定期メンテナンスのダイジェスト" "見出し行がある"

echo "=== scenario 6: settings.json に Setup(maintenance) が登録されている ==="
# WHY(2026-09-12): プラグインとして配られると、登録は**プラグインの hooks.json** にあり、
#      導入先の settings.json には無い。無いことを違反として読むと、
#      正しく入れた導入先ほど赤くなる（E-086）。登録が無ければ対象なしとして黙る。
REG="$(jq -r '.hooks.Setup[]? | select(.matcher == "maintenance") | .hooks[].command' "$SETTINGS" 2>/dev/null || true)"
if [ -z "$REG" ]; then
  ok "この導入先の settings.json には Setup(maintenance) の登録が無い（プラグイン側で登録される）ので対象なし"
else
  contains "$REG" "scripts/maintenance-digest.sh" "Setup(maintenance) から maintenance-digest.sh が呼ばれる"
fi

echo "=== scenario 7: 実態のランブック 7 本すべてから日付を読める（書式の回帰） ==="
# WHY(2026-09-12): 配った先が定期作業のランブックを持っているとは限らない。
#      持っていない導入先で「見つかりません」を違反として読むと、**持っていないだけで赤くなる**（E-086）。
#      1 本も持っていなければ対象なしとして黙る（1 本でもあれば書式の回帰として見る）。
REAL="$(MAINTENANCE_DIGEST_PLAIN=1 bash "$SCRIPT" < /dev/null)"
# WHY(2026-09-12): docs/agents/ はあってもランブックを 1 本も持たない導入先がある
#      （実測: 2 つの導入先とも docs/agents/ はあるがランブック 0 本）。
#      ディレクトリの有無で分けると「持っていないだけ」で赤くなるので、ランブックの実数で分ける。
RUNBOOK_N="$(find "$REPO_ROOT/docs/agents" -name '*runbook*.md' -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "${RUNBOOK_N:-0}" -eq 0 ]; then
  ok "この導入先は定期作業のランブックを 1 本も持たないのでランブックの検査は対象なし"
else
not_contains "$REAL" "読み取れません" "実態の 7 本は日付を読める"
not_contains "$REAL" "見つかりません" "実態の 7 本は存在する"
# WHY(#757-7): 定期作業を足したのに一覧へ出ていない、という抜けを検知する
contains "$REAL" "fault injection 訓練" "一覧に fault injection 訓練が出る"
contains "$REAL" "hook 実走ドリル" "一覧に hook 実走ドリルが出る"
contains "$REAL" "公式 docs 差分確認" "一覧に公式 docs 差分確認が出る"
contains "$REAL" "依存の月次棚卸し" "依存の棚卸しが実態のダイジェストに出る"
contains "$REAL" "鍵・権限の四半期棚卸し" "鍵・権限の棚卸しが実態のダイジェストに出る"
contains "$REAL" "テストの効き目の計測" "一覧にテストの効き目の計測が出る"
contains "$REAL" "認可そのものの効き目の計測" "一覧に認可そのものの効き目の計測が出る"
fi

echo "=== scenario 8: hook 実走ドリルは期限のほかに**配線の版**でも見る（2026-09-11） ==="
# WHY: ランブックは「hook を追加・変更したときに回す」と書いてあるのに、
#      変わったかどうかは誰も見ていなかった（期限＝四半期だけが機械化されていた）。
HASHER="$SCRIPT_DIR/lib/hook-registry-hash.mjs"
if [ ! -f "$HASHER" ] || ! command -v node >/dev/null 2>&1; then
  ng "版の走査器（lib/hook-registry-hash.mjs）か node が無い"
else
  if CURRENT="$(node "$HASHER" --root "$REPO_ROOT" 2>/dev/null)"; then
    ok "実態の配線から版を出せる（${CURRENT}）"
  elif ! grep -q 'scripts/' "$REPO_ROOT/.claude/settings.json" 2>/dev/null; then
    # WHY(2026-09-12): プラグイン経由の導入先は hook を**プラグインの hooks.json** 側で登録する。
    #      自分の settings.json に AIDD のスクリプトを書いていない導入先では版を出せなくて当然で、
    #      それを違反として読むと持っていないだけで赤くなる（E-086）
    CURRENT=""
    ok "この導入先は settings.json に AIDD の hook を登録していない（プラグイン側で登録される）ので版は対象なし"
  else
    CURRENT=""
    ng "実態の配線から版を出せない"
  fi
fi

hook_doc_with() {
  # $1=最後に実走した版（空なら未記録） $2=入れた時点の版
  {
    printf '# x\n\n## 実走した版\n\n'
    if [ -n "$1" ]; then printf '最後に実走した版: `%s`\n' "$1"; else printf '最後に実走した版: 未記録\n'; fi
    printf 'この仕組みを入れた時点の版: `%s`\n' "$2"
    printf '\n## 次回実施予定日\n\n%s（目安）\n' "$(iso_offset 60)"
  } > "$WORK/hl.md"
}

if [ -n "${CURRENT:-}" ]; then
  write_doc "$WORK/fi.md" "$(iso_offset 30)"
  write_doc "$WORK/ud.md" "$(iso_offset 10)"
  write_doc "$WORK/du.md" "$(iso_offset 20)"
  write_doc "$WORK/ar.md" "$(iso_offset 90)"
  write_doc "$WORK/mt.md" "$(iso_offset 45)"
  write_doc "$WORK/rm.md" "$(iso_offset 91)"

  hook_doc_with "$CURRENT" "$CURRENT"
  run_digest
  not_contains "$OUT" "hook 実走ドリル（版）" "実走した版が今と同じなら何も言わない"

  hook_doc_with "deadbeef1234" "$CURRENT"
  run_digest
  contains "$OUT" "hook の登録か中身が変わっています" "版が違えば警告する"
  contains "$OUT" "deadbeef1234" "実走した版を名指しする"
  contains "$OUT" "$CURRENT" "いまの版も出す"

  hook_doc_with "" "$CURRENT"
  run_digest
  contains "$OUT" "実走時の版がまだ記録されていません" "未記録かつ配線が変わっていなければ、記録を促すだけ"
  not_contains "$OUT" "⚠ hook が変わっています" "その場合は警告にしない（毎回鳴らさない）"

  hook_doc_with "" "0000deadbeef"
  run_digest
  contains "$OUT" "⚠ hook が変わっています" "未記録で配線も変わっていれば警告する"

  # 実態のランブックに戻す（後続で使わないが、fixture を残したまま終えない）
  write_doc "$WORK/hl.md" "$(iso_offset 60)"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
