#!/usr/bin/env bash
set -uo pipefail

# WHY: 2026-09-07。統合テストが 2 件、いつからか分からないほど前から赤いまま放置されていた。
#      GitHub の CI が止まっている間、`supabase/` を触った変更を守るのは統合テストだけなのに、
#      「最後に全件を通したのはいつで、結果は何だったか」を誰も記録していなかった。
#      だから「赤い」ことにも「一度も回していない」ことにも誰も気づけなかった。
#
#      SessionStart で、直近の記録（scripts/run-integration-tests.sh が残す）を見て
#      次のいずれかなら警告する。ブロックはしない（既存の staleness hook と同じ強さ）。
#        (a) 記録が 1 件も無い
#        (b) 直近が fail
#        (c) 直近を記録したときから `supabase/` の中身が変わっている
#        (d) 直近が未コミットの変更を含む状態での実行だった
#
#      (c) を「日数」ではなく **supabase/ の木のハッシュ**で見るのは、
#      無関係な変更で警告が鳴っても人が無視するようになるため。
#      守りたいのは「この木で通したか」であって「最近走らせたか」ではない。
#
# WHY(判定は共有の engine に置く・2026-09-08): 同じ形の検査を E2E にも足した（E-060）ので、
#      判定を 2 つ書くと片方だけ古くなる。engine は scripts/lib/run-freshness.py、
#      ここが渡すのは「何を見張るか」「どう回すか」だけ。
#
# WHY(警告専用・jq 不在時は静かに終わる): 既存の check-*-staleness.sh と同じ設計。
#      ブロックしない hook なので、jq が無い環境では警告が出ないだけにする（issue #636）。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/integration-runs.jsonl"
# WHY(2026-09-12): `git rev-parse "HEAD:supabase"` は**コミットが 1 つも無い木**で
#      `HEAD:supabase` を**標準出力にも**書いてから失敗する。`2>/dev/null` では取りこぼし、
#      `|| echo unknown` と合わさって値が 2 行になり、`= "unknown"` の比較が偽になる。
#      その結果「supabase/ を持たない導入先では黙る」が効かず、赤くなっていた（E-090 の続き）。
#      `--verify --quiet` なら失敗時に何も出さない。
SUPABASE_TREE="$(git rev-parse --verify --quiet "HEAD:supabase" 2>/dev/null || echo unknown)"

# supabase/ を持たないリポジトリ（プラグイン導入先など）では何も言わない
if [ "$SUPABASE_TREE" = "unknown" ]; then
  exit 0
fi

MSG="$(python3 "$SCRIPT_DIR/lib/run-freshness.py" \
  --log "$LOG_FILE" \
  --label "統合テスト" \
  --runner "bash scripts/run-integration-tests.sh" \
  --tree "supabase=$SUPABASE_TREE" \
  --changed-note "migration・RLS・統合テストのどれかが動いたということなので、")"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
