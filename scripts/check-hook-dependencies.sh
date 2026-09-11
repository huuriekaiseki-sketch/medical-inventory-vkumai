#!/usr/bin/env bash
# SessionStart hook。**検知 hook が、この環境でそもそも動くか**を毎回見る。
#
# WHY(2026-09-11): hook はほぼすべて fail-open（材料が取れなければ沈黙）で設計してある。
#   壊れても何も起きないので、hook 自身には壊れたことに気づく手段が無い。
#   実走ドリル（docs/agents/hook-live-drill.md）が同じ問題を**人が打つ手順**として持ち、
#   2026-09-05 に回して 1 日で 7 件の無音死を見つけたが、**起動が人**なので忘れれば止まる。
#   ここはその前段を機械化する——「動かす前に、動く条件が揃っているか」。
#
#   配布物ではさらに効き目が落ちる。導入先の環境には `jq` や `python3` が無いことがあり、
#   そこで沈黙しても、導入先の人には「検知が入っている」ようにしか見えない。
#
#   実測（2026-09-11、中心リポジトリ）: hook の実体 42 本のうち **41 本が `jq` を呼ぶ**。
#   `jq` が無い環境では **32 本が黙って降りる**。配布物の KNOWN-LIMITS は
#   node / python3 / npx しか挙げておらず、実態より狭かった。
#
# 走査の本体は scripts/lib/aidd-doctor.mjs（何に依存するかは**実測**する。宣言表は持たない——
# 持つと実態とずれる。C-010）。
#
# 環境変数（テスト用の注入ポイント）:
#   AIDD_DOCTOR_ASSUME_MISSING   実行系が「無い」ことにして診断する（例: jq,python3）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SCRIPT_DIR/lib/aidd-doctor.mjs"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# node が無ければ診断そのものができない。**その事実だけは伝える**（黙って消えない）
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"[hook 依存] node が無いので hook の生存診断ができません。node を入れるまで、検知 hook が動いているかは誰も見ていない状態です。"}'
  exit 0
fi
[ -f "$DOCTOR" ] || exit 0

# 診断は「沈黙しうる hook があれば exit 1」。出力の 1 行目以降に名指しが並ぶ。
# WHY(配列を使わない): macOS の bash 3.2 では、空配列の `"${A[@]}"` が `set -u` の下で
#      unbound variable になる。**この hook 自身が黙って死ぬ**ので、分岐で書く。
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  OUT="$(node "$DOCTOR" "$REPO_ROOT" --plugin-root "$CLAUDE_PLUGIN_ROOT" 2>&1)"
else
  OUT="$(node "$DOCTOR" "$REPO_ROOT" 2>&1)"
fi
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0

# 名指しの行だけを拾う（末尾の集計行は出さない）
SUMMARY="$(printf '%s\n' "$OUT" | sed -n 's/^aidd-doctor: /・/p')"
[ -z "$SUMMARY" ] && exit 0

MSG="[hook 依存] この環境では一部の検知 hook が期待どおり動きません。
${SUMMARY}
**黙って降りるものは、警告が出ないだけで止まりもしません**（fail-open）。
足りない実行系を入れるか、その hook に頼らない前提で進めてください。
詳しく見る: node scripts/lib/aidd-doctor.mjs --verbose"

if command -v jq >/dev/null 2>&1; then
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
  }'
else
  # WHY: jq が無いことを伝える hook が jq を要求したら、**まさにその状況で黙る**。
  #      ここだけは jq 無しでも出せるようにする（JSON は最小限を手で組む）。
  ESCAPED="$(printf '%s' "$MSG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
  printf '{"systemMessage":%s,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$ESCAPED" "$ESCAPED"
fi
