#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。セッション中にnpm run ai:check相当（typecheck/lint/test/e2e）が
# 実行されたかをtranscriptから機械的に検査し、ソース変更があるのに未実行なら
# systemMessageで警告する（Claude本体のBashツールを経由しないため、非対話環境の
# 許可プロンプト制約を受けない）。

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')"

STATE_DIR=".claude/.ai-check-suggest-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.hash"

# 7日より古い状態ファイルは掃除する（セッションごとに増え続けるのを防ぐ）
find "$STATE_DIR" -name '*.hash' -mtime +7 -delete 2>/dev/null || true

CHANGED_FILES="$( { git diff --name-only HEAD; git status --porcelain | awk '{print $2}'; } 2>/dev/null || true)"
CURRENT_HASH="$(printf '%s' "$CHANGED_FILES" | shasum -a 256 | awk '{print $1}')"

PREV_HASH=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH="$(cat "$STATE_FILE")"
fi

if [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
  exit 0
fi

# ソースコード変更（ドキュメント・設定のみの変更は対象外）がなければチェック不要
if ! printf '%s' "$CHANGED_FILES" | grep -qE '\.(ts|tsx|sql)$'; then
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
  exit 0
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
  exit 0
fi

# WHY: 以前はtranscript全文に対してgrepしていたため、警告文自体(MSG)に含まれる
# "npm run ai:check"という文字列がtranscriptへ記録されると、次回以降のgrepが自分自身の
# 警告文にマッチして「実行済み」と誤判定し、以降永久に警告が出なくなる自己抑制バグが
# あった（issue #635）。実際に実行されたBashコマンド（tool_useブロックのinput.command）
# だけを対象にすることで、警告文自体・会話中の言及（実行を伴わない）の両方を除外する。
EXECUTED_COMMANDS="$(jq -r 'select(.message.content? != null) | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command' "$TRANSCRIPT" 2>/dev/null || true)"

# 実行済みとみなすコマンドは aidd.config.json の commands（check / test / lint / typecheck）から作る
# （issue #420 v1 セット B2。コマンド体系はスタック固有）。設定が無ければ従来の npm 既定で判定する。
# `npm run X` と `npm X` は同じ意味なので両方を許す（"npm test" 設定でも "npm run test" を実行済み扱い）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/aidd-config.sh" ]; then
  source "$SCRIPT_DIR/lib/aidd-config.sh"
else
  aidd_config_query() { printf '%s' "${2:-}"; }
fi
DEFAULT_CHECK_PATTERN='npm run (ai:check|typecheck|lint|test)\b'
CHECK_PATTERN="$(aidd_config_query '
  def esc: gsub("[.^$*+?()\\[\\]{}|\\\\]"; "\\\\" + .);
  def variants: if test("^npm run ") then [., sub("^npm run "; "npm ")]
                elif test("^npm ") then [., sub("^npm "; "npm run ")]
                else [.] end;
  [ (.commands // {}) | to_entries[] | .value | select(type == "string" and length > 0) | variants[] | esc ]
  | unique | join("|")' '')"
if [ -n "$CHECK_PATTERN" ]; then
  CHECK_PATTERN="(${CHECK_PATTERN})\\b"
else
  CHECK_PATTERN="$DEFAULT_CHECK_PATTERN"
fi
CHECK_LABEL="$(aidd_config_query '.commands.check // empty' 'npm run ai:check')"

if printf '%s' "$EXECUTED_COMMANDS" | grep -qE "$CHECK_PATTERN"; then
  # WHY: 状態ハッシュは「実行済みと確認できた場合のみ」書き込む（issue #635）。
  # 未実行のまま書き込むと、同一diff状態での再Stopが30行目の早期returnで
  # 無条件にスキップされ、警告が最大1回しか出なくなってしまう。
  echo "$CURRENT_HASH" > "$STATE_FILE"
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
else
  MSG="ソースコード変更（.ts/.tsx/.sql）があるにもかかわらず、このセッションで ${CHECK_LABEL} 相当のコマンド（typecheck/lint/test）が実行された痕跡が見当たりません。実行を検討してください。"
  jq -n --arg msg "$MSG" '{systemMessage: $msg}'
fi
