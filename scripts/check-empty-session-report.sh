#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636と同型の
# 予防策）。ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# WHY: issue #673。docs/sessions/配下のセッションレポートは ~/aidd_session_report.sh
# （リポジトリ外・Stop hook）が自動生成するが、2026-06-28以降「結果」欄（うまくいったこと/
# 問題・気になった点/次の課題）が全空のまま放置されるテンプレが27ファイル中18件（67%）
# 蓄積していた実測がある（PR #672でtracked分16件削除済み）。
# 生成元スクリプト側にはfeature未記録・phase未実行時に生成自体をスキップするガードを
# 追加済みだが、そのガード自体にバグがあった場合や別経路で空テンプレが紛れ込んだ場合に
# 機械的に気づく手段が無いままだった（docs/agents/decisions.mdの「検知手段を先に決める」
# 原則）。本スクリプトはSessionStart hookとして、前回セッション終了後に残った空テンプレを
# 検知する（Stop hookではなくSessionStartにした理由: レポート生成自体がリポジトリ外の
# Stop hookで行われるため、同一Stop hookイベント内での実行順序に依存せず、次回セッション
# 開始時に確実に検知できるタイミングを選んだ）。
#
# 検知ロジック:
# - git status --porcelain で docs/sessions/ 配下の未コミット（untracked/modified）な
#   .mdファイルを列挙する（コミット済みで既に人間がレビューを終えたファイルは対象外）
# - 各ファイルの「## 結果」セクション以下、うまくいったこと/問題・気になった点/次の課題の
#   3行がいずれも「- 見出し:」のまま（コロンの後に内容が無い）ならテンプレ未記入とみなす
#
# 既知の限界:
# - 「## 結果」という見出し文言・3項目の文言が変わった場合は追従できない（部分文字列一致）
# - コミット済みファイルは対象外のため、うっかりgit addしてしまった空テンプレは検知しない
#   （その場合はレビュー時の目視に依存する）
#
# 環境変数（テスト用の注入ポイント。check-local-main-freshness.shと同型）:
#   EMPTY_SESSION_REPORT_PROJECT_DIR  対象プロジェクトディレクトリの代替（既定: このスクリプトの親）

command -v git >/dev/null 2>&1 || exit 0

PROJECT_DIR="${EMPTY_SESSION_REPORT_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

[ -d docs/sessions ] || exit 0

UNCOMMITTED_FILES="$(git status --porcelain -- docs/sessions/ 2>/dev/null | awk '{print $NF}' | grep -E '\.md$' || true)"
[ -n "$UNCOMMITTED_FILES" ] || exit 0

EMPTY_FILES=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  # 「## 結果」以降の本文を取り出し、3項目すべてが空（コロン直後に何も無い）かを判定する
  RESULT_BODY="$(awk '/^## 結果/{flag=1; next} flag' "$f")"
  [ -n "$RESULT_BODY" ] || continue
  if printf '%s\n' "$RESULT_BODY" | grep -qE '^- (うまくいったこと|問題・気になった点|次の課題): *\S'; then
    continue
  fi
  EMPTY_FILES="${EMPTY_FILES}${f}\n"
done <<< "$UNCOMMITTED_FILES"

[ -n "$EMPTY_FILES" ] || exit 0

FILE_LIST="$(printf '%b' "$EMPTY_FILES" | sed '/^$/d')"

MSG="docs/sessions/配下に「結果」欄が未記入のまま残っているセッションレポートがあります（issue #673）。生成元（~/aidd_session_report.sh）は既にガード済みのため今後は新規生成が抑制される見込みですが、既存の未コミットファイルは手動での記入・削除を検討してください。
${FILE_LIST}"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
