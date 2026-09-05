#!/usr/bin/env bash
set -euo pipefail

# WHY(issue #741): 期限付きの定期作業が 3 つあり（fault-injection 訓練、hook 実走ドリル、公式 docs
# 差分確認）、それぞれ SessionStart hook が個別に期限切れを警告している。ただし SessionStart は
# 「たまたま始めたセッション」でしか鳴らず、「いつやるか」は人の記憶に残っていた。Claude Code の
# `Setup` hook（`claude -p --maintenance` で発火、matcher `maintenance`）を定期作業の入口にし、
# 3 つの予定日と経過日数を 1 つのダイジェストで出す。手動実行（`bash scripts/maintenance-digest.sh`）
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

OVERDUE=0
BODY="$(
  line_for "fault injection 訓練" "${FAULT_INJECTION_DRILL_DOC:-docs/agents/fault-injection-drill.md}" "手順: docs/agents/fault-injection-drill.md「## 実行手順」"
  line_for "hook 実走ドリル" "${HOOK_LIVE_DRILL_DOC:-docs/agents/hook-live-drill.md}" "手順: docs/agents/hook-live-drill.md「## 手順」"
  line_for "公式 docs 差分確認" "${UPSTREAM_DOCS_REVIEW_DOC:-docs/agents/upstream-docs-review.md}" "手順: docs/agents/upstream-docs-review.md「## 手順（1〜2 時間）」"
)"
# サブシェル内の加算は親に戻らないため、本文の ⚠ を数え直す
OVERDUE="$(printf '%s\n' "$BODY" | grep -c '⚠' || true)"

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
