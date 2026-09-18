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

response = payload.get("tool_response") or {}
if isinstance(response, str):
    text, fields = response, {}
else:
    fields = response
    text = "\n".join(
        str(fields.get(k, "")) for k in ("stdout", "stderr", "output", "content", "error")
    )

# 終了コードは版によって名前が違うので、在りそうなものを順に見る。
# どれも無ければ本文の見た目で判断する（無音で素通りするより、拾いすぎる方を選ぶ）。
exit_code = None
for key in ("exit_code", "exitCode", "returnCode", "code", "status"):
    v = fields.get(key)
    if isinstance(v, int):
        exit_code = v
        break

FAILURE_MARKS = ("FAILED", "Tests  ", "failed", "✗", "×", "  NG: ", "error TS", "✖")
if exit_code is not None:
    failed = exit_code != 0
else:
    # vitest は成功時も "Tests  N passed" を出すので、失敗の形だけを見る
    failed = bool(
        re.search(r"\bTests\b.*\b\d+ failed", text)
        or re.search(r"^\s*FAILED\s*$", text, re.M)
        or re.search(r"^\s*NG: ", text, re.M)
        or re.search(r"^\s*×\s", text, re.M)
        or re.search(r"error TS\d+", text)
    )

if not failed:
    sys.exit(0)

# 落ちたものの名前を拾う（vitest の × 行、bash 検査の NG: 行、tsc のエラー行）
names = []
for pat in (r"^\s*×\s+(.+?)(?:\s+\d+ms)?$", r"^\s*NG:\s+(.+)$", r"^(.+?\(\d+,\d+\): error TS\d+.*)$"):
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
    # 終了コードが読めなかったときは、次のドリルで形を直せるように残す
    "responseKeys": sorted(fields.keys()) if exit_code is None else None,
    "failed": uniq[:20],
    "failedCount": len(uniq),
}
with open(out_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY

exit 0
