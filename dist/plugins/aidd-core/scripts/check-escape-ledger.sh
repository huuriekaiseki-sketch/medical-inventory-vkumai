#!/usr/bin/env bash
set -uo pipefail

# WHY: 2026-09-07。ルールブックに書いた「限界」が的外れかどうかは、書いた時点では分からない。
#      分かるのはテストやレビューで漏れが出たときだけ。その漏れをルールブックへ戻さないと、
#      限界はいつまでも当てが外れたままになる。
#
#      record-test-failure.sh（PostToolUse）が落ちた検査を下書きとして拾う。
#      この Stop hook は、下書きがあるのに**取りこぼし台帳を触っていない**ときに聞く。
#      判定はしない（落ちたテストが全部「取りこぼし」ではない。実装途中の RED は正常）。
#      聞くだけ。これで「記録し忘れ（見えない）」が「聞かれたのに答えなかった（見える）」になる。
#
#      黙るのは 2 通りだけ:
#        (a) 台帳 docs/agents/escaped-defects.md を、いちばん新しい下書きより後に触った
#        (b) bash scripts/triage-escapes.sh --none "理由" で「見たが該当なし」を記録した
#      どちらも痕跡が残る。何もしないで黙る道は無い。
#
# 見つけられること: 落ちた検査を見なかったこと
# 見つけられないこと: 台帳に書いた中身が正しいか。Bash 以外で気づいた漏れ（レビュー指摘など）
#
# WHY(警告専用・jq 不在時は静かに終わる): 既存の Stop hook と同じ（issue #636）。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_DIR="$(resolve_log_dir)"
CANDIDATES="$LOG_DIR/escape-candidates.jsonl"
LEDGER="${ESCAPE_LEDGER:-$REPO_ROOT/docs/agents/escaped-defects.md}"

[ -f "$CANDIDATES" ] || exit 0

# 台帳を最後に触った時刻（作業ツリーの更新時刻。コミット前でも「触った」と見なす）
LEDGER_MTIME=0
if [ -f "$LEDGER" ]; then
  LEDGER_MTIME="$(python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" "$LEDGER" 2>/dev/null || echo 0)"
fi

MSG="$(python3 - "$CANDIDATES" "$LEDGER_MTIME" <<'PY'
import json, sys
from datetime import datetime, timezone

path, ledger_mtime = sys.argv[1], int(sys.argv[2])

rows = []
triaged_at = 0
with open(path, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("triaged"):
            # 「見たが該当なし」の印。これより古い下書きは片付いたものとして扱う
            triaged_at = max(triaged_at, int(datetime.fromisoformat(row["at"]).timestamp()))
            continue
        rows.append(row)

def ts(row):
    try:
        return int(datetime.fromisoformat(row["at"]).timestamp())
    except (KeyError, ValueError):
        return 0

# 台帳を触った時刻・triage の印、どちらか新しい方より後の下書きだけが「未対応」
cutoff = max(ledger_mtime, triaged_at)
pending = [r for r in rows if ts(r) > cutoff]
if not pending:
    sys.exit(0)

lines = []
for r in pending[-5:]:
    names = r.get("failed") or []
    head = names[0] if names else "（テスト名を拾えず）"
    more = f"（他 {len(names) - 1} 件）" if len(names) > 1 else ""
    lines.append(f"  - {head}{more} ← {r.get('command', '')[:80]}")

print(
    f"落ちた検査が {len(pending)} 回ありました。取りこぼし台帳（docs/agents/escaped-defects.md）を見ましたか。\n"
    + "\n".join(lines)
    + "\n"
    "実装途中の RED なら何もしなくてよいですが、**ルールブックが見るはずだったのに見逃していた**なら、\n"
    "台帳に 1 行足して、そのルールブックの「## 限界」も直してください。\n"
    "該当なしと判断したときは `bash scripts/triage-escapes.sh --none \"理由\"` で記録してください（黙って消えません）。"
)
PY
)"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{ systemMessage: $msg }'
