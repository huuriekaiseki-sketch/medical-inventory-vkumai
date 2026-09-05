#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #523。.aidd/recovery-queue.jsonl（scripts/queue-recovery-task.shが追記する）に
# status="pending"のエントリが溜まっていないかをSessionStart時に確認し、あればcontextへ
# 注入する。人間がwarningを読んで指示するのを待たず、次のセッション開始時点で自動的に
# 「何を復旧すべきか」が目の前に出てくることで、検知→復旧の閉ループを1段階前進させる。
#
# 設計方針:
# - このhook自体は復旧作業を実行しない（自律実行はセッション本体が行う）。役割は
#   「pendingエントリの存在をセッション冒頭のcontextへ確実に届けること」に限定する
# - 注入時にstatusを"pending"から"surfaced"へ書き換え、surfacedAtを記録する（同一エントリを
#   毎セッション繰り返し表示しないため）。"surfaced"→"resolved"への遷移自体は
#   scripts/resolve-recovery-task.sh（issue #579）が担う。本hookはresolved化を実行しない
# - 追記（issue #579）: status="surfaced"のままsurfacedAtから既定閾値（既定72時間、
#   RECOVERY_QUEUE_STALE_HOURSで変更可）以上経過しているエントリを別枠でエスカレーション
#   表示する。resolved化されず放置されているタスクへの機械的な気づきを与えるためだが、
#   これも警告止まりであり、resolve-recovery-task.shの呼び忘れ自体をblockする手段ではない
#   （docs/agents/recovery-queue.md「安全上の制約」参照）
# - 日付計算はmacOS(BSD date)とLinux(GNU date)でdate -d/-jの互換性が無いため、
#   このリポジトリの他staleness系スクリプト（check-blocked-issues-staleness.sh等）と
#   同様python3に委ねる
# - fail-open: 判定材料が取れないケース（jq不在・キューファイル無し・python3不在等）は
#   すべて沈黙する
# - 全経路 exit 0（block不可）
#
# 環境変数（テスト用の注入ポイント）:
#   RECOVERY_QUEUE_FILE         キューファイルパス（既定 .aidd/recovery-queue.jsonl）
#   RECOVERY_QUEUE_STALE_HOURS  surfaced放置とみなす経過時間（既定72）

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

QUEUE_FILE="${RECOVERY_QUEUE_FILE:-.aidd/recovery-queue.jsonl}"
STALE_HOURS="${RECOVERY_QUEUE_STALE_HOURS:-72}"
if ! [[ "$STALE_HOURS" =~ ^[0-9]+$ ]]; then
  STALE_HOURS=72
fi

command -v jq >/dev/null 2>&1 || exit 0
[ -f "$QUEUE_FILE" ] || exit 0

PENDING_COUNT="$(jq -R -r 'fromjson? | select(.status == "pending")' "$QUEUE_FILE" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)"
case "$PENDING_COUNT" in
  ''|*[!0-9]*) PENDING_COUNT=0 ;;
esac

STALE_SURFACED_JSON="$(jq -R -r 'fromjson? | select(.status == "surfaced" and .surfacedAt != null)' "$QUEUE_FILE" 2>/dev/null | jq -s '.' 2>/dev/null || echo '[]')"
if [ -z "$STALE_SURFACED_JSON" ]; then
  STALE_SURFACED_JSON='[]'
fi
STALE_SURFACED_JSON="$(printf '%s' "$STALE_SURFACED_JSON" | python3 -c "
import json, sys
from datetime import datetime, timezone, timedelta

entries = json.load(sys.stdin)
threshold = datetime.now(timezone.utc) - timedelta(hours=$STALE_HOURS)
stale = []
for e in entries:
    try:
        surfaced = datetime.fromisoformat(e['surfacedAt'].replace('Z', '+00:00'))
    except Exception:
        continue
    if surfaced < threshold:
        stale.append(e)
print(json.dumps(stale))
" 2>/dev/null || echo '[]')"
if [ -z "$STALE_SURFACED_JSON" ]; then
  STALE_SURFACED_JSON='[]'
fi
STALE_COUNT="$(printf '%s' "$STALE_SURFACED_JSON" | jq 'length' 2>/dev/null || echo 0)"
case "$STALE_COUNT" in
  ''|*[!0-9]*) STALE_COUNT=0 ;;
esac

if [ "$PENDING_COUNT" -eq 0 ] && [ "$STALE_COUNT" -eq 0 ]; then
  exit 0
fi

MSG=""

if [ "$PENDING_COUNT" -gt 0 ]; then
  SUMMARY="$(jq -R -r 'fromjson? | select(.status == "pending") | "- [\(.type)] \(.timestamp): \(.detail | tostring)"' "$QUEUE_FILE" 2>/dev/null || true)"
  MSG="未対応の復旧タスクが${PENDING_COUNT}件あります（.aidd/recovery-queue.jsonl、issue #523）。停止①②・サーキットブレーカーを迂回しない範囲で、内容を確認し対応してください（対応後は \`scripts/resolve-recovery-task.sh --id <ID>\` で解決済みにしてください）:
${SUMMARY}"
fi

if [ "$STALE_COUNT" -gt 0 ]; then
  STALE_SUMMARY="$(printf '%s' "$STALE_SURFACED_JSON" | jq -r '.[] | "- [\(.type)] id=\(.id) surfacedAt=\(.surfacedAt)"')"
  STALE_MSG="復旧キューに${STALE_HOURS}時間以上resolved化されていないsurfaced済みエントリが${STALE_COUNT}件あります（issue #579）。表示されただけで対応が止まっている可能性があります。内容を確認し\`scripts/resolve-recovery-task.sh\`で解決済みにするか、対応不要なら理由をissue化してください:
${STALE_SUMMARY}"
  if [ -n "$MSG" ]; then
    MSG="${MSG}

${STALE_MSG}"
  else
    MSG="$STALE_MSG"
  fi
fi

# statusを"pending"→"surfaced"に書き換え、surfacedAtを記録して再書き込みする（他行は無変更）。
# 書き込みに失敗しても（disk full・read-only等）クラッシュせず、次回もpendingのまま
# 再表示されるだけで実害は軽微なため、fail-openでそのまま進める
if [ "$PENDING_COUNT" -gt 0 ]; then
  SURFACED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  TMP_FILE="$(mktemp "$(dirname "$QUEUE_FILE")/.recovery-queue.XXXXXX" 2>/dev/null || true)"
  if [ -n "$TMP_FILE" ]; then
    if jq -R -r --arg surfacedAt "$SURFACED_AT" 'fromjson? | if .status == "pending" then (.status = "surfaced") + {surfacedAt: $surfacedAt} else . end | tostring' "$QUEUE_FILE" > "$TMP_FILE" 2>/dev/null; then
      mv "$TMP_FILE" "$QUEUE_FILE" 2>/dev/null || rm -f "$TMP_FILE"
    else
      rm -f "$TMP_FILE"
    fi
  fi
fi

jq -n --arg msg "$MSG" '{systemMessage: $msg}'

exit 0
