#!/usr/bin/env bash
set -uo pipefail

# WHY(2026-09-10): 認可の本体は RLS ポリシーにあり、その**テストの効き目**を測るのが
#      `scripts/check-rls-mutation.sh`（ポリシーを 1 つ壊して、対応するテストが落ちるか）。
#      ところがこの計測は**人が打たないと動かない**。ハーネスの地図（harness-map.md）で
#      「起動: 人」と書いていた 3 つのうちの 1 つがこれ。
#
#      打ち忘れを自己申告に頼ると、統合テスト（E-030）・E2E（E-060）で起きたのと同じこと——
#      「いつからか分からないほど前から赤いまま」——が起こる。
#      SessionStart で直近の記録を見て、次のいずれかなら警告する（ブロックはしない）:
#        (a) 記録が 1 件も無い
#        (b) 直近が fail（生き残った変異がある＝守っていないテストがある）
#        (c) 直近を記録したときから `supabase/` の中身が変わっている
#        (d) 直近が未コミットの変更を含む状態での実行だった
#
#      (c) を**日数ではなく木のハッシュ**で見るのは、無関係な変更で鳴る警告は読まれないから。
#      守りたいのは「このポリシーの姿で測ったか」であって「最近走らせたか」ではない。
#      定期の引き金（四半期）は maintenance-digest.sh が別に持っている——
#      **こちらは「変わったのに測っていない」を見る**ので、役割が違う。
#
# WHY(判定は共有の engine): 統合テスト・E2E とまったく同じ形なので、判定は
#      scripts/lib/run-freshness.py に置いてある。ここが渡すのは
#      「何を見張るか」「どう回すか」だけ（3 つ目を足しても判定は 1 つのまま）。
#
# WHY(警告専用・jq 不在時は静かに終わる): 既存の check-*-freshness.sh と同じ設計。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/rls-mutation-runs.jsonl"
SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"

# supabase/ を持たないリポジトリ（プラグイン導入先など）では何も言わない
if [ "$SUPABASE_TREE" = "unknown" ]; then
  exit 0
fi

# WHY(壊し方の登録簿が無ければ黙る): 変異の計測を導入していないリポジトリで
#      「一度も回していない」と言い続けても直しようがない
[ -f "$SCRIPT_DIR/lib/rls-mutants.json" ] || exit 0

MSG="$(python3 "$SCRIPT_DIR/lib/run-freshness.py" \
  --log "$LOG_FILE" \
  --label "RLS の変異計測" \
  --runner "bash scripts/check-rls-mutation.sh" \
  --tree "supabase=$SUPABASE_TREE" \
  --changed-note "ポリシーか、それを守るテストが動いたということなので、")"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
