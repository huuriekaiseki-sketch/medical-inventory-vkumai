#!/usr/bin/env bash
set -uo pipefail

# WHY: 落ちた検査の下書き（record-test-failure.sh が拾う）を「見たが取りこぼしではなかった」と
#      片付けるための印を残す。黙って消す道を作らないための唯一の出口。
#      理由を必須にしているのは、後から「何を見送ったか」を数えられるようにするため
#      （見送りばかりなら、そもそも拾い方が粗いという合図になる）。
#
# 使い方:
#   bash scripts/triage-escapes.sh --none "実装途中の RED。入力検証を足す前のテスト"
#
# 取りこぼしだった場合はこのコマンドではなく、docs/agents/escaped-defects.md に 1 行足す
# （台帳を触れば Stop hook は自動で黙る）。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

mode=""
reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --none) mode="none"; reason="${2:-}"; shift 2 ;;
    *) echo "triage-escapes: 知らない引数: $1" >&2; exit 2 ;;
  esac
done

if [ "$mode" != "none" ]; then
  echo "triage-escapes: --none \"理由\" が要る" >&2
  exit 2
fi
if [ ${#reason} -lt 5 ]; then
  echo "triage-escapes: 理由を書いてください（5 文字以上）" >&2
  exit 2
fi

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"
FILE="$LOG_DIR/escape-candidates.jsonl"

python3 - "$FILE" "$reason" <<'PY'
import json, sys
from datetime import datetime, timezone

path, reason = sys.argv[1], sys.argv[2]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "triaged": True,
    "reason": reason,
}
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[triage-escapes] 「見たが該当なし」を記録しました: {reason}")
PY
