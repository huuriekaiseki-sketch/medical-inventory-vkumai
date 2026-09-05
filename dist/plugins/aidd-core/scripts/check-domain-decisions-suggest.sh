#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。高リスクドメイン（auth / RLS / policy と aidd.config.json の語）に触れたセッションで、
# docs/agents/domain.md・decisions.md への追記漏れがないかを促す。
#
# WHY（agent型からcommand型へ置き換えた理由・issue #685）:
# 元は type:"agent" のStop hookで、サブエージェントがtranscript全文を読んで
#   (1) 変更ファイルの抽出
#   (2) 「設計判断を含むか」の判断
#   (3) 同一セッション内の重複通知の抑止
# を全部やっていた。しかし (1)(3) は機械的に決まる判定であり、LLMに任せる必要がない。
# 実際、抑止条件に該当して「発火しない」と判断する場面でも毎ターンサブエージェントが
# 起動し、しかも「何も返さないでください」という指示に反して判定理由を返し続けていた
# （2026-08-30のセッションで10回以上観測）。鳴り続ける通知は読まれなくなる。
#
# 本スクリプトは (1)(3) をシェルで決定的に処理し、(2) の「設計判断かどうか」の判断だけを
# メインループ側へ委ねる。メインループは変更の文脈を既に持っているため、transcriptを
# 読み直すサブエージェントより安く、かつ正確に判断できる。
#
# 既知の限界: 元のagent版は「ファイルパスだけでなく実際の変更内容が
# 高リスクドメインに関わるか」も見ていた。本スクリプトはパスとファイル名までしか
# 見ないため、無関係なパスに置かれたドメイン変更は拾えない（偽陰性）。
# その代わり偽陽性（毎ターンの空振り）を無くし、通知が読まれる状態を保つ方を優先した。

# WHY(issue #420): プラグイン配布ではスクリプト位置がリポジトリ外になるため CLAUDE_PROJECT_DIR を優先する
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"

silent() {
  :  # 報告事項なし。公式仕様では表示しないなら systemMessage を省略する（issue #737。以前は空文字を出していた）
  exit 0
}

STATE_DIR=".claude/.domain-decisions-suggest-state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.done"

# 7日より古い状態ファイルは掃除する（セッションごとに増え続けるのを防ぐ）
find "$STATE_DIR" -name '*.done' -mtime +7 -delete 2>/dev/null || true

# WHY: 重複抑止はマーカーファイルで行う。transcript本文をgrepする方式は、警告文自体が
#      transcriptに記録されて次回以降マッチする自己抑制バグを生む（issue #635の再発防止）。
if [ -f "$STATE_FILE" ]; then
  silent
fi

CHANGED_FILES="$( { git diff --name-only HEAD; git status --porcelain | awk '{print $2}'; } 2>/dev/null || true)"
if [ -z "$CHANGED_FILES" ]; then
  silent
fi

# 高リスクパスは docs/agents/common.md「TRI/RISK 機械判定基準」＝ router-risk.js の汎用既定値
# （auth / rls / policy / migration、middleware.ts / proxy.ts）に aidd.config.json の risk
# （固有: DB マイグレーション配下等）を足したもの（issue #420 v1 セット B2）。
# WHY: 語尾変化を拾うため語幹で照合する。`policy` と書くと `policies/` に一致せず
#      取りこぼす（テストで検出）。`polic`→policy/policies のように末尾の y を落とす。
#      語幹化は「末尾の y を落とす」だけの機械規則にし、設定側は普通の語で書けるようにする。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/aidd-config.sh" ]; then
  source "$SCRIPT_DIR/lib/aidd-config.sh"
else
  aidd_config_query() { printf '%s' "${2:-}"; }
fi
DEFAULT_RISK_PATTERN='(^|/)middleware\.ts$|(^|/)proxy\.ts$|(auth|rls|polic|migration)'
EXTRA_RISK_PATTERN="$(aidd_config_query '
  def esc: gsub("[.^$*+?()\\[\\]{}|\\\\]"; "\\\\" + .);
  def stem: sub("y$"; "");
  [ ((.risk.pathPrefixes // [])[] | "^" + esc),
    ((.risk.domainKeywords // [])[] | stem | esc) ]
  | join("|")' '')"
RISK_PATTERN="$DEFAULT_RISK_PATTERN"
if [ -n "$EXTRA_RISK_PATTERN" ]; then
  RISK_PATTERN="${DEFAULT_RISK_PATTERN}|${EXTRA_RISK_PATTERN}"
fi
MATCHED="$(printf '%s' "$CHANGED_FILES" | grep -iE "$RISK_PATTERN" || true)"

if [ -z "$MATCHED" ]; then
  silent
fi

FILE_LIST="$(printf '%s' "$MATCHED" | sort -u | head -10 | tr '\n' ' ')"
DOMAIN_WORDS="$(aidd_config_query '(.risk.domainKeywords // []) | join("/")' 'auth/rls/policy')"
DOMAIN_DOC="$(aidd_config_query '.docs.domain // empty' 'docs/agents/domain.md')"
DECISIONS_DOC="$(aidd_config_query '.docs.decisions // empty' 'docs/agents/decisions.md')"

MSG="このセッションは高リスクドメイン（${DOMAIN_WORDS} 等）のファイルに触れています: ${FILE_LIST}
その変更が、単なるコメント修正・タイポ・変数名変更ではなく、後戻りしづらい／記録がないと後から理由が分からなくなる／本当にトレードオフがあった設計判断（RLSポリシーの方針、権限境界の変更、DBスキーマ変更の理由など）を含むなら、${DOMAIN_DOC}（新しいドメイン用語）と ${DECISIONS_DOC}（設計判断）への追記を検討してください。該当しなければ対応は不要です。"

touch "$STATE_FILE"
jq -n --arg msg "$MSG" '{systemMessage: $msg}'
