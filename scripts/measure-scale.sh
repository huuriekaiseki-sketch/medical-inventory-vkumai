#!/usr/bin/env bash
# WHY: issue #757 の 19（性能と上限）。「数万件になったら何が壊れるか」を推測せず測る。
#      ローカル Supabase に 1 施設ぶんの発注と明細を作り、一覧・明細・施設削除の時間を出す。
#      結果は docs/agents/performance-baseline.md の表に追記する。
#
#      これは CI では回さない（時間がかかり、しきい値テストは環境差で揺れる）。
#      test-matrix の「性能の実測」は節目（依存の major 更新・外部公開前・スキーマ変更で
#      索引が増減したとき）に人が起動する。
#
# 使い方:
#   bash scripts/measure-scale.sh                 # 既定 3,000 発注 / 9,000 明細
#   ORDERS=30000 bash scripts/measure-scale.sh    # 件数を変える
#   ITEMS_PER_ORDER=5 bash scripts/measure-scale.sh
#
# 前提: npx supabase start 済み。書き込みは service role で行い、後片付けまでやる。
#       本番には絶対に向けない（.env.test のガードと同じく、URL が localhost であることを確認する）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"
case "$URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "measure-scale: ローカル以外の Supabase には向けられない: $URL" >&2
    exit 1
    ;;
esac

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "measure-scale: SUPABASE_SERVICE_ROLE_KEY が要る（npx supabase status で確認できる）" >&2
  exit 1
fi

exec env SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY" SUPABASE_URL="$URL" \
  node "$REPO_ROOT/scripts/lib/measure-scale.mjs"
