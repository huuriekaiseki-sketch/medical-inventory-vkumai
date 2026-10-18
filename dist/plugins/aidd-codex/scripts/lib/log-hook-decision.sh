#!/usr/bin/env bash
# 止める hook（PreToolUse の deny / ask / warn）が「止めた」ことを 1 行残す（docs/specs/hook-decision-log.md）。
#
# WHY: 2026-10-18 の棚卸しで、止める力を持つ hook 5 本のどれも止めたことをどこにも書いておらず、
#      「hook が何を何回止めたか」を数えられる記録が 1 つも無いと分かった。唯一それに近い
#      docs/agents/harness-score.jsonl は issue を閉じるとき人が書く自己申告で、verify-claims の記録は
#      2,617 件中 2,563 件が fail_open（「止めた」ではなく「動いていなかった」の記録）だった。
#      この 1 行があれば、可視化の元データになり、「止めているはずの hook が一度も発火していない」
#      にも気づける（verify-claims と同じ型の無音死の検知）。
#
# 使い方: source してから、判定の JSON を出す直前に 1 回呼ぶ
#   source "$SCRIPT_DIR/lib/log-hook-decision.sh"
#   log_hook_decision <hook名> <deny|ask|warn> <rule> <tool_name> <target> <hook入力JSON>
#     hook名   … スクリプト名（拡張子なし）。同じ hook は同じ名前で
#     rule     … どの規則に当たったか。固定語彙（仕様書の表）
#     target   … Bash は実行されようとした**先頭の語だけ**（例: psql）、Write 系はファイルパス。
#                コマンド本文は渡さない（接続文字列のパスワード等が記録に残る余地を無くす）
#     入力JSON … hook が stdin で受け取った JSON そのまま。session_id / agent_type / cwd をここから読む
#
# 記録先: ${AIDD_HOOK_DECISION_LOG_FILE:-<resolve_log_dir>/hook-decisions.jsonl}
#   （scripts/lib/resolve-log-dir.sh。worktree 横断で 1 か所。環境変数はテスト・手動検証での差し替え用）
#
# 契約（ここが崩れると判定の hook を壊す）:
#   - **呼び出し側の stdout / stderr / 終了コードを 1 文字も変えない。** 中は丸ごと subshell で包み、
#     何が起きても 0 を返す。呼び出し側は `set -euo pipefail` のままでよい
#   - 書けない（ディレクトリ不可・jq 無し・git 無し）ときは**黙って飛ばす**。知らせると hook の
#     stdout が変わり、判定の契約に触る（仕様書「決めてほしいこと 6」）。記録が無いことは集計側が
#     「0 件」として見せる
#   - allow（黙って通した回）は書かない（仕様書「決めてほしいこと 1」）
#
# caller（誰が hook を呼んだか。仕様書「決めてほしいこと 5」）:
#   1. 環境変数 AIDD_HOOK_CALLER があればその値（Codex 用ラッパー 2 本が codex を渡す）
#   2. 無ければ tool_name が apply_patch なら codex（Codex のファイル編集だけがこの名前）
#   3. それでもなければ CLAUDE_PROJECT_DIR があれば claude
#   4. どれでもなければ unknown。確実に分かる手がかりだけで決め、当てずっぽうで claude にしない
#      （Codex が check-direct-ddl-execution.sh を直接呼ぶ経路にはラッパーが無く、ここに落ちる見込み）

_LOG_HOOK_DECISION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_hook_decision() {
  # WHY(subshell + set +e): 呼び出し側が set -euo pipefail でも、この中の失敗を外へ漏らさない。
  #     subshell の exit は関数の return にはならず、末尾の || true と return 0 で必ず 0 に揃う
  (
    set +e +u +o pipefail
    hook="$1"; decision="$2"; rule="$3"; tool_name="$4"; target="$5"; input="${6:-}"

    command -v jq >/dev/null 2>&1 || exit 0

    log_file="${AIDD_HOOK_DECISION_LOG_FILE:-}"
    if [ -z "$log_file" ]; then
      [ -f "$_LOG_HOOK_DECISION_LIB_DIR/resolve-log-dir.sh" ] || exit 0
      source "$_LOG_HOOK_DECISION_LIB_DIR/resolve-log-dir.sh"
      log_file="$(resolve_log_dir)/hook-decisions.jsonl"
    fi

    caller="${AIDD_HOOK_CALLER:-}"
    if [ -z "$caller" ]; then
      if [ "$tool_name" = "apply_patch" ]; then
        caller="codex"
      elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
        caller="claude"
      else
        caller="unknown"
      fi
    fi

    session_id="$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)"
    agent_type="$(printf '%s' "$input" | jq -r '.agent_type // ""' 2>/dev/null)"
    cwd="$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)"
    branch="$(git -C "${cwd:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    mkdir -p "$(dirname "$log_file")" 2>/dev/null || exit 0
    jq -nc \
      --arg timestamp "$timestamp" \
      --arg hook "$hook" \
      --arg decision "$decision" \
      --arg rule "$rule" \
      --arg tool_name "$tool_name" \
      --arg target "$target" \
      --arg caller "$caller" \
      --arg agent_type "$agent_type" \
      --arg session_id "$session_id" \
      --arg branch "$branch" \
      '{timestamp: $timestamp, hook: $hook, decision: $decision, rule: $rule, tool_name: $tool_name,
        target: $target, caller: $caller, agent_type: $agent_type, session_id: $session_id, branch: $branch}' \
      >> "$log_file"
  ) >/dev/null 2>&1 || true
  return 0
}
