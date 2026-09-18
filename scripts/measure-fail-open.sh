#!/usr/bin/env bash
# WHY: issue #757 の 31（fail-open）。棚卸し（docs/agents/fail-open-inventory.md）の 19 行のうち
#      **実際に依存を止めて測ったのは 1 行だけ**で、残りはコードを読んだ判断だった。
#      静的検査が見られるのは「`error` を受け取っているか」まで。**error として返るのか
#      throw されるのか**は本物を止めないと分からない。結果は同ファイルの実施記録に追記する。
#
#      これは CI では回さない（docker のコンテナを止める）。
#      test-matrix の「障害注入（外部依存停止）」は節目（依存の major 更新・外部公開前）に人が起動する。
#
# 使い方:
#   bash scripts/measure-fail-open.sh
#
# 前提: supabase start 済み。**ローカル以外には絶対に向けない**（URL を確認する）。
#       途中で失敗しても、この script が最後に必ずコンテナを起動し直す。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="${SUPABASE_PROJECT_ID:-medical-inventory-vkumai}"

URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"
case "$URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "measure-fail-open: ローカル以外の Supabase には向けられない: $URL" >&2
    exit 1
    ;;
esac

command -v docker > /dev/null 2>&1 || {
  echo "measure-fail-open: docker が要る（依存を止めるため）" >&2
  exit 1
}

CONTAINERS=("supabase_rest_${PROJECT}" "supabase_auth_${PROJECT}")
DB_CONTAINER="supabase_db_${PROJECT}"
# WHY: DB の中を壊す測定（F-011 / F-012）は、壊す前に「戻し方」をここへ書く。
#      プロセスごと落ちてテストの finally が走らなかったときの**最後の砦**
RESTORE_FILE="$REPO_ROOT/.aidd/fault-injection-restore.sql"

restore() {
  echo "--- 後始末: 止めたコンテナを起動し直す"
  for c in "${CONTAINERS[@]}"; do
    docker start "$c" > /dev/null 2>&1 && echo "  started: $c" || echo "  （起動済み or 不在）: $c"
  done
  # 起動直後は接続を受け付けないことがあるので少し待つ
  sleep 3

  if [ -f "$RESTORE_FILE" ]; then
    echo "--- 後始末: DB の中に壊したものが残っている。復元 SQL を適用する"
    if docker cp "$RESTORE_FILE" "$DB_CONTAINER:/tmp/fault-restore.sql" > /dev/null 2>&1 &&
       docker exec "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
         -f /tmp/fault-restore.sql > /dev/null 2>&1; then
      echo "  復元しました: $RESTORE_FILE"
      rm -f "$RESTORE_FILE"
    else
      echo "  **復元に失敗しました。手で当ててください**: $RESTORE_FILE" >&2
    fi
  fi
}
# **測定が途中で落ちても必ず戻す。** 止めっぱなしは以後のすべての作業を壊す
trap restore EXIT INT TERM

for c in "${CONTAINERS[@]}"; do
  if ! docker inspect "$c" > /dev/null 2>&1; then
    echo "measure-fail-open: コンテナが無い: ${c}（supabase start 済みか確認する）" >&2
    exit 1
  fi
done

cd "$REPO_ROOT" || exit 1
# WHY(npx を使わない): npx はレジストリから取りに行きうる（scripts/check-no-registry-fetch.test.sh）。
#      入っているものだけを使う
./node_modules/.bin/vitest run --config vitest.fault-injection.config.ts
