#!/usr/bin/env bash
# WHY(C-041、2026-09-09): `scripts/check-full-run-before-finish.sh` の回帰テスト。
#      この hook は「単体で緑にして終える」を終える瞬間に止めるためのもので、
#      **黙るべきときに黙り、鳴るべきときに鳴る**ことが命。
#      鳴りすぎれば読まれなくなり（C-031）、黙りすぎれば無いのと同じ。
#
#   1. いまの姿で全件を通していれば黙る
#   2. **未コミットの書き換え**があれば鳴る（HEAD の木は変わらないので、従来の判定では見えなかった）
#   3. **未追跡の新しいファイル**があっても鳴る（新しい migration はまず未追跡で置かれる）
#   4. 同一セッションでは 2 回目以降は黙る（毎ターン鳴らない）
#   5. 記録が 1 件も無ければ鳴る
#   6. 古い記録（いまの姿のハッシュを持たない）では従来の判定へ落ちる（黙って通さない）
#   7. 見張るパスが無いリポジトリでは黙る（プラグインの導入先）
#
# 実行: bash scripts/check-full-run-before-finish.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/check-full-run-before-finish.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_silent() {
  if [ -z "$1" ]; then echo "  OK: $2"; else echo "  NG: $2"; echo "      unexpected: $1"; fail=1; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 見張る先のミニリポジトリを作る（git 管理・supabase/ と e2e/ と src/ を持つ）
REPO="$WORK/repo"
mkdir -p "$REPO/supabase/migrations" "$REPO/e2e" "$REPO/src" "$REPO/logs"
cd "$REPO" || exit 1
git init -q .
git config user.email t@example.test
git config user.name t
printf 'select 1;\n' > supabase/migrations/0001.sql
printf 'export const a = 1\n' > e2e/a.ts
printf 'export const b = 1\n' > src/b.ts
git add -A
git commit -qm init

# hook は resolve-log-dir.sh で記録先を決める。テストでは logs/ を直接使わせる
export CLAUDE_LOG_DIR="$REPO/logs"

run_hook() { # $1=セッションID $2=マーカー
  FULL_RUN_CHECK_ROOT="$REPO" \
  FULL_RUN_CHECK_SESSION_ID="$1" \
  FULL_RUN_CHECK_MARKER="$2" \
    bash "$HOOK" 2>&1
}

# いまの姿のハッシュで「通した」記録を書く
record_pass() {
  # shellcheck source=lib/worktree-hash.sh
  source "$SCRIPT_DIR/lib/worktree-hash.sh"
  local sup e2e src
  sup="$(cd "$REPO" && worktree_hash supabase)"
  e2e="$(cd "$REPO" && worktree_hash e2e)"
  src="$(cd "$REPO" && worktree_hash src)"
  local supt e2et srct
  supt="$(cd "$REPO" && git rev-parse HEAD:supabase)"
  e2et="$(cd "$REPO" && git rev-parse HEAD:e2e)"
  srct="$(cd "$REPO" && git rev-parse HEAD:src)"
  printf '{"at":"2026-09-09T00:00:00Z","result":"pass","supabaseTree":"%s","supabaseDirty":false,"supabaseWorktree":"%s"}\n' "$supt" "$sup" > "$REPO/logs/integration-runs.jsonl"
  printf '{"at":"2026-09-09T00:00:00Z","result":"pass","e2eTree":"%s","srcTree":"%s","e2eDirty":false,"srcDirty":false,"e2eWorktree":"%s","srcWorktree":"%s"}\n' "$e2et" "$srct" "$e2e" "$src" > "$REPO/logs/e2e-runs.jsonl"
}

echo "=== scenario 1: いまの姿で全件を通していれば黙る ==="
record_pass
OUT="$(run_hook s1 "$WORK/m1.json")"
assert_silent "$OUT" "変更が無ければ何も言わない"

echo "=== scenario 2: 未コミットの書き換えがあれば鳴る（HEAD の木は変わらない） ==="
printf 'select 2;\n' > "$REPO/supabase/migrations/0001.sql"
BEFORE_TREE="$(cd "$REPO" && git rev-parse HEAD:supabase)"
OUT="$(run_hook s2 "$WORK/m2.json")"
AFTER_TREE="$(cd "$REPO" && git rev-parse HEAD:supabase)"
if [ "$BEFORE_TREE" = "$AFTER_TREE" ]; then
  echo "  OK: HEAD の木は変わっていない（従来の判定では見えない状況）"
else
  echo "  NG: 前提が崩れている（HEAD の木が変わった）"; fail=1
fi
assert_contains "$OUT" "いまの \`supabase/\` の状態では統合テストを通していません" "書き換えを検知"
assert_contains "$OUT" "単体のテストだけを緑にして終えていないか" "C-041 の言葉で伝える"
printf 'select 1;\n' > "$REPO/supabase/migrations/0001.sql"

echo "=== scenario 3: 未追跡の新しいファイルでも鳴る（新しい migration は未追跡） ==="
printf 'select 3;\n' > "$REPO/supabase/migrations/0002_new.sql"
OUT="$(run_hook s3 "$WORK/m3.json")"
assert_contains "$OUT" "いまの \`supabase/\` の状態では統合テストを通していません" "未追跡ファイルを検知"
rm -f "$REPO/supabase/migrations/0002_new.sql"

echo "=== scenario 4: 同一セッションでは 2 回目以降は黙る ==="
record_pass
printf 'export const b = 2\n' > "$REPO/src/b.ts"
MARK="$WORK/m4.json"
OUT1="$(run_hook s4 "$MARK")"
OUT2="$(run_hook s4 "$MARK")"
assert_contains "$OUT1" "いまの \`src/\` の状態ではE2Eを通していません" "1 回目は鳴る"
assert_silent "$OUT2" "2 回目は黙る（毎ターン鳴らない）"
# 別のセッションなら鳴る
OUT3="$(run_hook s4-other "$MARK")"
assert_contains "$OUT3" "いまの \`src/\` の状態ではE2Eを通していません" "セッションが変われば鳴る"
printf 'export const b = 1\n' > "$REPO/src/b.ts"

echo "=== scenario 5: 記録が 1 件も無ければ鳴る ==="
rm -f "$REPO/logs/integration-runs.jsonl" "$REPO/logs/e2e-runs.jsonl"
OUT="$(run_hook s5 "$WORK/m5.json")"
assert_contains "$OUT" "統合テストを通した記録が 1 件もありません" "記録なしを検知"

echo "=== scenario 6: 古い記録（いまの姿のハッシュが無い）は従来の判定へ落ちる ==="
printf '{"at":"2026-09-09T00:00:00Z","result":"pass","supabaseTree":"stale","supabaseDirty":false}\n' > "$REPO/logs/integration-runs.jsonl"
printf '{"at":"2026-09-09T00:00:00Z","result":"pass","e2eTree":"stale","srcTree":"stale","e2eDirty":false,"srcDirty":false}\n' > "$REPO/logs/e2e-runs.jsonl"
OUT="$(run_hook s6 "$WORK/m6.json")"
assert_contains "$OUT" "の中身が変わっています" "古い記録でも黙って通さない"

echo "=== scenario 7: 見張るパスが無いリポジトリでは黙る ==="
BARE="$WORK/bare"
mkdir -p "$BARE/logs"
cd "$BARE" || exit 1
git init -q .
git config user.email t@example.test
git config user.name t
printf 'x\n' > readme.md
git add -A
git commit -qm init
CLAUDE_LOG_DIR="$BARE/logs" FULL_RUN_CHECK_ROOT="$BARE" FULL_RUN_CHECK_SESSION_ID=s7 \
  FULL_RUN_CHECK_MARKER="$WORK/m7.json" OUT="$(bash "$HOOK" 2>&1)"
assert_silent "${OUT:-}" "supabase/ も e2e/ も無ければ黙る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
