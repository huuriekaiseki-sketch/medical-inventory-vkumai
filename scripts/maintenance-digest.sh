#!/usr/bin/env bash
set -euo pipefail

# WHY(issue #741): 期限付きの定期作業が 5 つあり（fault-injection 訓練、hook 実走ドリル、公式 docs
# 差分確認、テストの効き目の計測、認可そのものの効き目の計測 = issue #757 の 7）、それぞれ SessionStart hook が個別に期限切れを警告している。ただし SessionStart は
# 「たまたま始めたセッション」でしか鳴らず、「いつやるか」は人の記憶に残っていた。Claude Code の
# `Setup` hook（`claude -p --maintenance` で発火、matcher `maintenance`）を定期作業の入口にし、
# それぞれの予定日と経過日数を 1 つのダイジェストで出す。手動実行（`bash scripts/maintenance-digest.sh`）
# でも同じ出力が得られる。
#
# 判定は各ランブックの「## 次回実施予定日」直下の YYYY-MM-DD（既存の staleness hook と同じ書式）。
# 出力: Setup hook の JSON（systemMessage）。期限超過が 1 つも無くても「次の期限」を一覧で出す
# （ダイジェストの目的は「いつやるか」を見せることで、超過の警告だけではない）。
#
# 環境変数（テスト用の注入ポイント。各 staleness hook と同じ名前）:
#   FAULT_INJECTION_DRILL_DOC   既定 docs/agents/fault-injection-drill.md
#   HOOK_LIVE_DRILL_DOC         既定 docs/agents/hook-live-drill.md
#   UPSTREAM_DOCS_REVIEW_DOC    既定 docs/agents/upstream-docs-review.md
#   DEPENDENCY_UPDATE_DOC       既定 docs/agents/dependency-update-runbook.md（issue #757 の 21 で追加。4 つ目）
#   ACCESS_REVIEW_DOC           既定 docs/agents/access-review-runbook.md（issue #757 の 36 で追加。5 つ目）
#   MUTATION_TESTING_DOC        既定 docs/agents/mutation-testing.md
#   RLS_MUTATION_DOC            既定 docs/agents/rls-mutation.md
#   MAINTENANCE_DIGEST_PLAIN=1  JSON でなく人が読む素のテキストで出す（手動実行用）

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

# stdin（hook 入力）は読み捨てる。setup_type は maintenance 前提（settings.json の matcher で絞る）
cat >/dev/null 2>&1 || true

# $1: ランブックのパス → "OK <due> <days_left>" / "DUE <due> <days_over>" / "NO_DATE" / "MISSING"
judge() {
  local doc="$1"
  if [ ! -f "$doc" ]; then
    echo "MISSING"
    return 0
  fi
  python3 -c "
import re, sys
from datetime import date

with open(sys.argv[1], encoding='utf-8') as f:
    text = f.read()
m = re.search(r'## 次回実施予定日\s*\n+(\d{4}-\d{2}-\d{2})', text)
if not m:
    print('NO_DATE')
    sys.exit(0)
due = date.fromisoformat(m.group(1))
today = date.today()
if today >= due:
    print(f'DUE {due.isoformat()} {(today - due).days}')
else:
    print(f'OK {due.isoformat()} {(due - today).days}')
" "$doc" 2>/dev/null || echo "NO_DATE"
}

# $1: 表示名, $2: ランブック, $3: 実施コマンド/参照
line_for() {
  local name="$1" doc="$2" howto="$3" result
  result="$(judge "$doc")"
  case "$result" in
    MISSING) printf '%s: ランブックが見つかりません（%s）\n' "$name" "$doc" ;;
    NO_DATE) printf '%s: 「## 次回実施予定日」から日付を読み取れません（%s）\n' "$name" "$doc" ;;
    DUE*)
      printf '%s: ⚠ 期限 %s を %s 日超過。%s\n' "$name" "$(cut -d' ' -f2 <<<"$result")" "$(cut -d' ' -f3 <<<"$result")" "$howto"
      OVERDUE=$((OVERDUE + 1))
      ;;
    OK*)
      printf '%s: 期限 %s（あと %s 日）\n' "$name" "$(cut -d' ' -f2 <<<"$result")" "$(cut -d' ' -f3 <<<"$result")"
      ;;
  esac
}

# hook 実走ドリルだけは「期限」のほかに**版**でも見る。
#
# WHY(2026-09-11): ランブックは「hook を追加・変更したときに回す」と書いてあるのに、
#      **変わったかどうかを誰も見ていなかった**（期限＝四半期だけが機械化されていた）。
#      版は Claude 側（.claude/settings.json）と Codex 側（.codex/hooks.json）の登録と
#      実体の中身から作る。Codex 側の 3 本は deny（止める側）なので、黙って死ぬほうが危ない。
#      考え方は fault injection 訓練の門（gate-prompt-hash.mjs）と同じ。
hook_version_line() {
  local doc="$1" hasher current status recorded baseline
  hasher="$(dirname "$0")/lib/hook-registry-hash.mjs"
  [ -f "$hasher" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$doc" ] || return 0
  # WHY(C-044): `set -e` の下で素の代入をすると、走査が非ゼロを返した瞬間にこの hook 自身が死ぬ
  if current="$(node "$hasher" --root "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  # 2 = この導入先は hook の登録を持たない。黙る
  [ "$status" -eq 2 ] && return 0
  if [ "$status" -ne 0 ] || [ -z "$current" ]; then
    # WHY(C-025): 「測れなかった」を合格に数えない
    printf 'hook 実走ドリル（版）: 版を数えられません（node scripts/lib/hook-registry-hash.mjs が失敗）。hook が変わったかを判定できない状態です。\n'
    return 0
  fi
  recorded="$(sed -n 's/^最後に実走した版: `\([0-9a-f]\{6,\}\)`.*/\1/p' "$doc" | tail -1)"
  baseline="$(sed -n 's/^この仕組みを入れた時点の版: `\([0-9a-f]\{6,\}\)`.*/\1/p' "$doc" | tail -1)"
  # WHY(この仕組みを持たない導入先では黙る): ランブックに版の欄が 1 つも無いなら、
  #      そこは「配線の版で見る」を採り入れていない。**無いことを警告にしない**
  #      （持っていない導入先で毎回鳴ると、他の行まで読まれなくなる）
  if [ -z "$recorded" ] && [ -z "$baseline" ] && ! grep -q '^最後に実走した版:' "$doc"; then
    return 0
  fi
  if [ -n "$recorded" ]; then
    [ "$recorded" = "$current" ] && return 0
    printf 'hook 実走ドリル（版）: ⚠ hook の登録か中身が変わっています（実走した版 %s / いまの版 %s）。変わった hook だけでも実走してください。\n' "$recorded" "$current"
    return 0
  fi
  if [ -n "$baseline" ] && [ "$baseline" = "$current" ]; then
    printf 'hook 実走ドリル（版）: 実走時の版がまだ記録されていません（次の実走で「最後に実走した版」に %s を書いてください）。\n' "$current"
    return 0
  fi
  printf 'hook 実走ドリル（版）: ⚠ hook が変わっています（いまの版 %s）。しかも実走時の版が未記録なので、どこから変わったかも分かりません。\n' "$current"
}

OVERDUE=0
BODY="$(
  line_for "fault injection 訓練" "${FAULT_INJECTION_DRILL_DOC:-docs/agents/fault-injection-drill.md}" "手順: docs/agents/fault-injection-drill.md「## 実行手順」"
  line_for "hook 実走ドリル" "${HOOK_LIVE_DRILL_DOC:-docs/agents/hook-live-drill.md}" "手順: docs/agents/hook-live-drill.md「## 手順」"
  hook_version_line "${HOOK_LIVE_DRILL_DOC:-docs/agents/hook-live-drill.md}"
  line_for "公式 docs 差分確認" "${UPSTREAM_DOCS_REVIEW_DOC:-docs/agents/upstream-docs-review.md}" "手順: docs/agents/upstream-docs-review.md「## 手順（1〜2 時間）」"
  line_for "依存の月次棚卸し" "${DEPENDENCY_UPDATE_DOC:-docs/agents/dependency-update-runbook.md}" "手順: docs/agents/dependency-update-runbook.md「## 手順（30 分）」"
  line_for "鍵・権限の四半期棚卸し" "${ACCESS_REVIEW_DOC:-docs/agents/access-review-runbook.md}" "手順: docs/agents/access-review-runbook.md「## 手順（30 分）」"
  line_for "テストの効き目の計測" "${MUTATION_TESTING_DOC:-docs/agents/mutation-testing.md}" "手順: docs/agents/mutation-testing.md「## 使い方」"
  line_for "認可そのものの効き目の計測" "${RLS_MUTATION_DOC:-docs/agents/rls-mutation.md}" "手順: docs/agents/rls-mutation.md「## 使い方」"
)"
# サブシェル内の加算は親に戻らないため、本文の ⚠ を数え直す。
# WHY(期限の ⚠ だけを数える。2026-09-11): 版の警告（hook の配線が変わった）は
#      **期限超過ではない**。同じ数に混ぜると「期限超過 N 件」が実態と合わなくなる（C-031）
OVERDUE="$(grep -c '⚠ 期限' <<<"$BODY" || true)"

HEADER="定期メンテナンスのダイジェスト（issue #741。claude -p --maintenance または bash scripts/maintenance-digest.sh）"
if [ "$OVERDUE" -gt 0 ]; then
  SUMMARY="期限超過 ${OVERDUE} 件。超過分を実施し、各ランブックの「## 次回実施予定日」と実施記録を更新してください。"
else
  SUMMARY="期限超過なし。次の期限は上の一覧のとおりです。"
fi
MSG="${HEADER}
${BODY}
${SUMMARY}"

if [ "${MAINTENANCE_DIGEST_PLAIN:-}" = "1" ]; then
  printf '%s\n' "$MSG"
  exit 0
fi

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "Setup", additionalContext: $msg }
}'
exit 0
