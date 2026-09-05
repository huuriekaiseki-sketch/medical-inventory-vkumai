#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #636はdeny/ask系ゲート3本(check-direct-ddl-execution.sh・
# check-skip-marker-write.sh・本ファイル)にfail-closedのjqガードを求めていたが、
# 本ファイルは3行下のコメントの通り常にpermissionDecision: "allow"のみを返す設計
# （ブロックせず警告を注入するだけ）で、他2本のようなdeny/askゲートではない。
# fail-closed(exit 2)にすると「絶対にブロックしない」という既存設計方針と矛盾するため、
# 本ファイルはfail-open（jq不在時は警告注入を諦めexit 0）にする。
command -v jq >/dev/null 2>&1 || exit 0

# PreToolUse hook。issue #444（issue #339「aidd-phase1-routerを経由せず直接実装に入れば
# 判定がまるごとスキップされる」の機械化・優先度2候補）。
#
# TRI/RISK基準（docs/agents/common.md「TRI/RISK 機械判定基準」）に該当する高リスクパスへの
# 書き込み(Write/Edit/MultiEdit)時に、.aidd/run-manifest.json（docs/agents/run-manifest.md）が
# 存在しなければ、ブロックせず警告のみをモデルに注入する（permissionDecision: "allow" +
# additionalContext）。人間の確認を要求する"ask"や実行そのものを止める"deny"ではない。
#
# v1スコープの明示（ファイル名を "presence" とした理由）:
# 本スクリプトはrun-manifest.jsonの**存在**のみを見る。issue #444の設計案が挙げていた
# 「鮮度」（baseCommitが現在のHEADと大きくズレていないか等）は、実装セッションが長時間に
# 及ぶ場合の誤検知リスクが高く、このプロジェクトの「まず観測から始める」方針
# （decisions.md「なぜ新しい運用ルールに『検知手段を先に決める』原則を導入したか」等）に
# 合わせて今回は見送った。鮮度判定を追加する場合は本ファイルを拡張するか、ファイル名ごと
# 見直すこと。
#
# 対象ツール: Write / Edit / MultiEdit（tool_input.file_pathに書き込み先が現れる）。
# .claude/settings.jsonのmatcherと本スクリプトのcase文の両方を揃える必要がある。

# 高リスクパスの判定は router-risk.js の DEFAULT_RISK_CONFIG（汎用: auth / rls / policy / migration と
# middleware.ts / proxy.ts）に、aidd.config.json の risk.pathPrefixes / risk.domainKeywords（固有:
# supabase/migrations/ 等）を足して作る（issue #420 v1 セット B2）。設定が無ければ汎用分だけで判定する
# （緩むのではなく固有語が足されないだけ）。大文字小文字は grep -i で吸収する。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/aidd-config.sh" ]; then
  source "$SCRIPT_DIR/lib/aidd-config.sh"
else
  aidd_config_query() { printf '%s' "${2:-}"; }
fi
DEFAULT_HIGH_RISK_PATTERN='(^|/)middleware\.ts$|(^|/)proxy\.ts$|auth|rls|policy|migration'
build_high_risk_pattern() {
  local root_hint="$1" extra
  # pathPrefixes は (^|/)接頭辞、domainKeywords は語の部分一致。正規表現の特殊文字はエスケープする
  extra="$(aidd_config_query '
    def esc: gsub("[.^$*+?()\\[\\]{}|\\\\]"; "\\\\" + .);
    [ ((.risk.pathPrefixes // [])[] | "(^|/)" + esc),
      ((.risk.domainKeywords // [])[] | esc) ]
    | join("|")' '' "$root_hint")"
  if [ -n "$extra" ]; then
    printf '%s|%s' "$DEFAULT_HIGH_RISK_PATTERN" "$extra"
  else
    printf '%s' "$DEFAULT_HIGH_RISK_PATTERN"
  fi
}

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"

TARGET=""
case "$TOOL_NAME" in
  Write|Edit|MultiEdit)
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')"
    ;;
  *)
    exit 0
    ;;
esac

if [[ -z "$TARGET" ]]; then
  exit 0
fi

REPO_ROOT="$(git -C "${CWD:-.}" rev-parse --show-toplevel 2>/dev/null || echo "")"

# WHY: tool_input.file_pathは絶対パスで渡ってくることがある。絶対パスのまま
# HIGH_RISK_PATTERNと照合すると、リポジトリの置き場所（worktreeパス等）自体に
# "inventory"のようなドメイン語が含まれているだけで常に誤検知する
# （実機で発見: /private/tmp/.../medical-inventory-vkumai/... への無関係な書き込みで発火した）。
# 必ずリポジトリルートからの相対パスに正規化してから照合する。
#
# 単純な文字列prefix比較(${TARGET#"$REPO_ROOT"/})はmacOSで実際に破綻することを実機確認済み:
# `git rev-parse --show-toplevel`はシンボリックリンクを解決した正規パス(/private/var/...)を
# 返すが、tool_input.file_path/cwdは非正規パス(/var/...、/varは/private/varへのシンボリック
# リンク)のまま渡ってくることがあり、文字列としては一致しない。python3のos.path.realpathで
# 両者を同じ基準に正規化してから比較する（このリポジトリの他スクリプトと同様、pathlib的な
# 処理はpython3に委ねる方針）。
RELATIVE_TARGET="$TARGET"
if [[ "$TARGET" = /* ]]; then
  if [[ -z "$REPO_ROOT" ]]; then
    exit 0
  fi
  RELATIVE_TARGET="$(python3 -c '
import os, sys
target, repo_root = sys.argv[1], sys.argv[2]
real_target = os.path.realpath(target)
real_root = os.path.realpath(repo_root)
rel = os.path.relpath(real_target, real_root)
if rel == os.pardir or rel.startswith(os.pardir + os.sep):
    sys.exit(1)
print(rel)
' "$TARGET" "$REPO_ROOT")" || exit 0
fi

HIGH_RISK_PATTERN="$(build_high_risk_pattern "$REPO_ROOT")"
if ! printf '%s' "$RELATIVE_TARGET" | grep -qiE "$HIGH_RISK_PATTERN"; then
  exit 0
fi

MANIFEST_PATH="${REPO_ROOT:-${CWD:-.}}/.aidd/run-manifest.json"

if [[ -f "$MANIFEST_PATH" ]]; then
  exit 0
fi

jq -n --arg ctx "高リスクパス($TARGET)への変更ですが、.aidd/run-manifest.jsonが見当たりません。aidd-phase1-routerを経由せず直接実装に入っていないか確認してください（意図した変更であればこのまま進めて構いません）。" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: $ctx}}'

exit 0
