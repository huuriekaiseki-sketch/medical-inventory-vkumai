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
# WHY(警告専用・jq 不在時は静かに終わる): 既存の check-*-staleness.sh と同じ設計。
#      ブロックしない hook なので、jq が無い環境では警告が出ないだけにする（issue #636）。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/integration-runs.jsonl"
SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"

# supabase/ を持たないリポジトリ（プラグイン導入先など）では何も言わない
if [ "$SUPABASE_TREE" = "unknown" ]; then
  exit 0
fi

MSG="$(python3 - "$LOG_FILE" "$SUPABASE_TREE" <<'PY'
import json, os, sys

log_file, tree = sys.argv[1], sys.argv[2]

if not os.path.exists(log_file):
    print("統合テスト（npm run test:integration）を通した記録が 1 件もありません。"
          "`bash scripts/run-integration-tests.sh` で回すと結果が記録され、次から鮮度を見られます。")
    sys.exit(0)

last = None
with open(log_file, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            last = json.loads(line)
        except json.JSONDecodeError:
            continue

if last is None:
    print("統合テストの記録ファイルは在りますが、読める行がありません。"
          "`bash scripts/run-integration-tests.sh` で回し直してください。")
    sys.exit(0)

when = last.get("at", "不明")
if last.get("result") != "pass":
    print(f"直近の統合テストは **失敗** のままです（{when}、branch {last.get('branch', '不明')}）。"
          "`bash scripts/run-integration-tests.sh` で再現し、赤を残したまま先へ進めないでください。")
    sys.exit(0)

if last.get("supabaseDirty"):
    print(f"直近の統合テストは通っていますが（{when}）、未コミットの `supabase/` 変更がある状態での実行でした。"
          "コミット後にもう一度 `bash scripts/run-integration-tests.sh` を回してください。")
    sys.exit(0)

if last.get("supabaseTree") != tree:
    print(f"直近に統合テストを通したとき（{when}）から `supabase/` の中身が変わっています。"
          "migration・RLS・統合テストのどれかが動いたということなので、"
          "`bash scripts/run-integration-tests.sh` を回してから作業を終えてください。")
    sys.exit(0)
PY
)"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
