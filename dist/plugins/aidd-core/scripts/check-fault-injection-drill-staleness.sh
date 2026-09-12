#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# SessionStart hookから呼ばれる。issue #443: 「検知手段のないルールの棚卸し」（issue #339）の
# 第3層ルールのうち、fault injection四半期訓練（issue #395）は
# docs/agents/fault-injection-drill.md「## 次回実施予定日」に「リマインド機構は無い」と
# 明記されたまま放置されていた。
#
# 設計判断（issue #443スコープの絞り込み。詳細はdocs/agents/decisions.md参照）:
# issue原案は「OS launchd等による夜間バッチジョブ」を想定していたが、対象読者(loop-observability
# /agent-progress gap check)は単発フロー実行の前後差分が前提の設計で夜間バッチに転用できず、
# eval:workflowsの実行記録自体も存在しないため、今回実装可能なのは本チェック（fault injection
# 訓練の期限切れ検知）のみだった。OS launchdのような常時稼働・無人でGitHub issueを作成しうる
# 仕組みを新設するのではなく、SessionStart hook（既に機械トリガーとして扱われる。issue #411の
# 原則を満たす）で「次回実施予定日」を過ぎていないか警告する形に留めた
# （check-blocked-issues-staleness.shと同じ「セッションが始まった時に気づける」最小限のバー）。
#
# 日付抽出はmacOS/Linuxのdate非互換を避けるため他のスクリプトと同様にpython3に委ねる。

# WHY(2026-09-12): 既定が相対パスなので、**cwd が導入先であること**に依存して成立していた。
#      hook 経由では cwd が変わりうるし、配られるとこの検査は配布物の中から呼ばれる（E-086・E-087）。
#      導入先のルートを明示できるときはそこを基準にする（環境変数での差し替えが最優先）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  DRILL_DOC="${FAULT_INJECTION_DRILL_DOC:-${CLAUDE_PROJECT_DIR}/docs/agents/fault-injection-drill.md}"
else
  DRILL_DOC="${FAULT_INJECTION_DRILL_DOC:-docs/agents/fault-injection-drill.md}"
fi

if [ ! -f "$DRILL_DOC" ]; then
  exit 0
fi

# ─── 門の文言が変わったのに訓練していないか（2026-09-11 追加） ───────────────
# WHY: 上の判定は**日付（四半期）しか見ていない**。ルール本体は「`aidd-phase2.js` の
#      Spec Check / Manifest Check 関連のプロンプトを変更したとき」にも回せと言っているのに、
#      そちらは誰も見ていなかった（undetectable-rules-inventory.md の第 3 層）。
#      「変わったのに測っていない」は変異計測の鮮度 hook と同じ形で見る。
#
#      ファイル全体ではなく**門の文言だけ**を数えるのは、`aidd-phase2.js` が別の理由でよく
#      変わるため（2026-09-10 の 164 行の変更でも門の文言は一字も動いていなかったと実測）。
#      毎回鳴る警告は読まれなくなる。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HASHER="$SCRIPT_DIR/lib/gate-prompt-hash.mjs"

# 環境変数（テスト用注入ポイント）: FAULT_INJECTION_GATE_VERSION で「いまの版」を差し替える
gate_version_message() {
  local current status
  if [ -n "${FAULT_INJECTION_GATE_VERSION:-}" ]; then
    current="$FAULT_INJECTION_GATE_VERSION"
    status=0
  else
    [ -f "$HASHER" ] || return 0
    command -v node >/dev/null 2>&1 || return 0
    # WHY(C-044): `set -e` の下で `VAR="$(...)"` の素の代入をすると、走査が非ゼロを返した瞬間に
    #      **この hook 自身が死んで何も言わなくなる**。`if` の条件に置いて免除する
    if current="$(node "$HASHER" --root "$REPO_ROOT" 2>/dev/null)"; then
      status=0
    else
      status=$?
    fi
  fi
  # 2 = この導入先はこの仕組みを持たない（設定が無い）。黙る
  [ "$status" -eq 2 ] && return 0
  if [ "$status" -ne 0 ] || [ -z "$current" ]; then
    # WHY(C-025): 「測れなかった」を合格に数えない。走査が壊れたら黙らずに言う
    printf '%s' "fault injection 訓練の「訓練したゲートの版」を数えられませんでした（\`node scripts/lib/gate-prompt-hash.mjs\` が失敗）。門の文言が変わったかどうか判定できない状態です。"
    return 0
  fi

  local recorded
  recorded="$(sed -n 's/^最後に訓練した版: `\([0-9a-f]\{6,\}\)`.*/\1/p' "$DRILL_DOC" | tail -1)"
  if [ -z "$recorded" ]; then
    printf '%s' "${DRILL_DOC} に「最後に訓練した版」の行がありません。どの版に対する訓練だったか分からないため、門の文言が変わったかを判定できません（\`node scripts/lib/gate-prompt-hash.mjs\` の出力を記録してください）。"
    return 0
  fi
  [ "$recorded" = "$current" ] && return 0
  printf '%s' "fault injection 訓練が守る**門の文言が変わっています**（訓練した版 ${recorded} / いまの版 ${current}）。Spec Check・Manifest Check は deny-by-default のゲートで、文言が変われば blocked を返さなくなる可能性があります。${DRILL_DOC} の 4 シナリオを回し、「最後に訓練した版」を更新してください。"
}

GATE_MSG="$(gate_version_message)"

RESULT="$(python3 -c "
import re, sys
from datetime import date

with open('$DRILL_DOC', encoding='utf-8') as f:
    text = f.read()

m = re.search(r'## 次回実施予定日\s*\n+(\d{4}-\d{2}-\d{2})', text)
if not m:
    print('NO_DATE')
    sys.exit(0)

due = date.fromisoformat(m.group(1))
today = date.today()
if today >= due:
    print(f'DUE {due.isoformat()} {(today - due).days}')
else:
    print('OK')
" 2>/dev/null || echo 'OK')"

# WHY(2 つの判定を潰さない・C-025): 「期限を過ぎた」と「門の文言が変わった」は別の理由で、
#      直し方も違う（前者は四半期の定期、後者は変更に対する再実施）。両方あれば両方出す。
DATE_MSG=""
if [ "$RESULT" = "NO_DATE" ]; then
  DATE_MSG="${DRILL_DOC}の「## 次回実施予定日」欄から日付を読み取れませんでした。書式が崩れていないか確認してください（issue #443）。"
elif [ "$RESULT" != "OK" ]; then
  DUE_DATE="$(printf '%s' "$RESULT" | cut -d' ' -f2)"
  DAYS_OVERDUE="$(printf '%s' "$RESULT" | cut -d' ' -f3)"
  DATE_MSG="fault injection訓練（${DRILL_DOC}）の次回実施予定日（${DUE_DATE}）を${DAYS_OVERDUE}日過ぎています。4シナリオを実施し、実施記録欄への追記と次回予定日の更新（\`docs/agents/fault-injection-drill.md\`「## 次回実施予定日」）をお願いします（issue #443）。"
fi

if [ -n "$DATE_MSG" ] && [ -n "$GATE_MSG" ]; then
  MSG="${DATE_MSG}
${GATE_MSG}"
elif [ -n "$DATE_MSG" ]; then
  MSG="$DATE_MSG"
elif [ -n "$GATE_MSG" ]; then
  MSG="$GATE_MSG"
else
  exit 0
fi

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
