#!/usr/bin/env bash
set -uo pipefail

# WHY: 2026-09-07。ルールブックに書いた「限界」が的外れかどうかは、書いた時点では分からない。
#      分かるのは**テストやレビューで漏れが出たとき**だけ。だからそこを拾って
#      ルールブックへ戻す輪（実装 → 検査 → 漏れ → ルールブックを直す → 実装）を閉じたい。
#      ただし輪の最初の一歩「漏れたことを記録する」を人の自己申告にすると、忘れれば無かったことになる。
#
#      そこで PostToolUse（Bash）で**落ちた検査を機械が拾って下書きにする**。
#      判定はしない（落ちたテストが全部「取りこぼし」ではない。実装途中の RED は正常）。
#      拾うだけ拾って、Stop hook（check-escape-ledger.sh）が「見ましたか」と聞く。
#      これで「記録し忘れ（見えない）」が「聞かれたのに答えなかった（見える）」に変わる。
#
# 見つけられること: 検査コマンドが落ちたこと、落ちたテスト名
# 見つけられないこと: それが取りこぼしか、実装途中の RED か（人が決める）。
#                     Bash 以外の経路で気づいた漏れ（レビューでの指摘など）は拾えない
#
# 対象: 「検査らしいコマンド」だけ。既定はどのリポジトリでも通じる語（test / lint / typecheck）で、
#       スタック固有の語（ブラウザ自動化ツール名など）は aidd.config.json の
#       `checkCommandPatterns` に足す（判定エンジンは共通、語彙は導入先。issue #420 と同じ分け方）。
#       設定は既定に**足すだけ**で、既定を消す手段は無い。
#
# WHY(警告専用・jq 不在時は静かに終わる): 既存の hook と同じ。記録が増えないだけで実害は無い。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
if [ -f "$SCRIPT_DIR/lib/aidd-config.sh" ]; then
  # shellcheck source=lib/aidd-config.sh
  source "$SCRIPT_DIR/lib/aidd-config.sh"
else
  aidd_config_query() { printf '%s' "${2:-}"; }
fi

INPUT="$(cat)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
[ -z "$COMMAND" ] && exit 0

DEFAULT_PATTERNS='test lint typecheck'
EXTRA_PATTERNS="$(aidd_config_query '.checkCommandPatterns // [] | join(" ")' '')"
matched=0
for pattern in $DEFAULT_PATTERNS $EXTRA_PATTERNS; do
  case "$COMMAND" in
    *"$pattern"*) matched=1; break ;;
  esac
done
[ "$matched" -eq 0 ] && exit 0

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"

# WHY(標準入力ではなく環境変数で渡す): `printf ... | python3 - <<'PY'` はヒアドキュメントが
#      stdin を奪うため、python 側の sys.stdin は空になる。JSONDecodeError を握って exit 0 して
#      いたので **何も記録しないまま成功したように見えた**（2026-09-07 に実測して踏んだ）。
#      fail-open の典型なので、入力の受け渡しは stdin を使わない形に固定する。
AIDD_HOOK_INPUT="$INPUT" python3 - "$LOG_DIR/escape-candidates.jsonl" "$COMMAND" <<'PY'
import json, os, re, sys
from datetime import datetime, timezone

out_file, command = sys.argv[1], sys.argv[2]
raw = os.environ.get("AIDD_HOOK_INPUT", "")
if not raw:
    sys.exit(0)
try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(0)

# WHY(issue #875): Bash が 0 以外で終わると、PostToolUse ではなく PostToolUseFailure が発火する。
#      この hook は長く PostToolUse にしか登録されておらず、**普通に落ちたテストは一度も届いていなかった**
#      （届いていたのは exit 0 で終わったのに本文に失敗の文字が出たものだけ。E-103）。
#      失敗時の入力は形が違い、公式は exit_code / stdout / stderr を tool_response の**外**に置くと書く。
#      実機の形はまだ測っていないので、内側・外側のどちらにあっても読む。
event = payload.get("hook_event_name") or ""
response = payload.get("tool_response")
fields = response if isinstance(response, dict) else {}
TEXT_KEYS = ("stdout", "stderr", "output", "content", "error")
parts = [response] if isinstance(response, str) else [str(fields.get(k, "")) for k in TEXT_KEYS]
parts += [str(payload.get(k, "")) for k in TEXT_KEYS]
text = "\n".join(p for p in parts if p)

# 終了コードは版によって名前と置き場が違うので、在りそうなものを順に見る。
# どれも無ければ本文の見た目で判断する（無音で素通りするより、拾いすぎる方を選ぶ）。
exit_code = None
for source in (fields, payload):
    for key in ("exit_code", "exitCode", "returnCode", "code", "status"):
        v = source.get(key)
        if isinstance(v, int) and not isinstance(v, bool):
            exit_code = v
            break
    if exit_code is not None:
        break

if exit_code is not None:
    failed = exit_code != 0
elif event == "PostToolUseFailure":
    # 失敗時のイベントで届いた時点で落ちている。本文の形を知らなくても拾う（形を知らないと無音になる）
    failed = True
else:
    # vitest は成功時も "Tests  N passed" を出すので、失敗の形だけを見る
    # WHY(issue #875): aidd-core は言語を問わず配るので、pytest / unittest の失敗の形も既定で知っておく。
    #      知らないと Python の導入先では下書きに一度も載らない（kojigyo-zei-rag への移植で発覚）
    failed = bool(
        re.search(r"\bTests\b.*\b\d+ failed", text)
        or re.search(r"^\s*FAILED\s*$", text, re.M)
        or re.search(r"^\s*NG: ", text, re.M)
        or re.search(r"^\s*×\s", text, re.M)
        or re.search(r"error TS\d+", text)
        # pytest: 末尾の要約行（`=== 1 failed, 140 passed in 1.23s ===`）と short summary（`FAILED path::test`）
        or re.search(r"^=+ .*\b\d+ (?:failed|errors?)\b.*=+\s*$", text, re.M)
        or re.search(r"^(?:FAILED|ERROR)\s+\S+::\S+", text, re.M)
        # unittest: `FAIL: test_x (mod.Class.test_x)` / `ERROR: ...`
        or re.search(r"^(?:FAIL|ERROR): \S", text, re.M)
    )

if not failed:
    sys.exit(0)

# 落ちたものの名前を拾う（vitest の × 行、bash 検査の NG: 行、tsc のエラー行、pytest のノード ID、unittest の FAIL: 行）
names = []
for pat in (
    r"^\s*×\s+(.+?)(?:\s+\d+ms)?$",
    r"^\s*NG:\s+(.+)$",
    r"^(.+?\(\d+,\d+\): error TS\d+.*)$",
    r"^(?:FAILED|ERROR)\s+(\S+::\S+)",
    r"^(?:FAIL|ERROR):\s+(.+)$",
):
    names += [m.strip() for m in re.findall(pat, text, re.M)]
seen, uniq = set(), []
for n in names:
    if n not in seen:
        seen.add(n)
        uniq.append(n)

row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "command": command[:300],
    "exitCode": exit_code,
    # どのイベントで届いたか（PostToolUse = exit 0 で本文に失敗 / PostToolUseFailure = 0 以外で終了）
    "event": event or None,
    "errorType": payload.get("error_type"),
    # 終了コードが読めなかったとき・失敗時のイベントで届いたときは、実機の入力の形を後から直せるように残す
    "responseKeys": sorted(fields.keys()) if exit_code is None else None,
    "inputKeys": sorted(payload.keys()) if (exit_code is None or event == "PostToolUseFailure") else None,
    "failed": uniq[:20],
    "failedCount": len(uniq),
}
with open(out_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY

exit 0
