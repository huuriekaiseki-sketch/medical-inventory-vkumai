#!/usr/bin/env bash
# scripts/lib/worktree-hash.sh
#
# WHY(2026-09-09・C-041): 「最後に全件を通したのはいつか」を **HEAD の木のハッシュ**で見ていたが、
#      それだと **未コミットの変更**が見えない。手元で migration を書き換えて、
#      単体のテストだけ緑にして終える——という一番ありがちな終わり方を、記録側が区別できなかった。
#      （`<name>Dirty` は「汚れていたか」の真偽しか持たず、**汚れの中身が変わっても同じ値**）
#
#      ここでは「いまその場所がどう見えるか」を 1 つのハッシュにする:
#        HEAD の木のハッシュ ＋ 追跡ファイルの差分 ＋ **未追跡ファイルの中身**
#      新しい migration は未追跡で置かれるので、3 つ目が無いと**新規ファイルに反応しない**。
#
# 限界:
#   - git 管理下でしか使えない（git が無ければ `unknown` を返す）
#   - `.gitignore` されたファイルは見ない（意図。生成物で警告を鳴らさない）
#   - 中身が同じで名前だけ違う変更も別のハッシュになる（それでよい。回し直す理由になる）
#
# 使い方: source して `worktree_hash <パス>`

# $1=リポジトリからの相対パス（例: supabase）。標準出力にハッシュを 1 行
worktree_hash() {
  local target="$1"
  git rev-parse --git-dir >/dev/null 2>&1 || { echo unknown; return 0; }
  {
    git rev-parse "HEAD:$target" 2>/dev/null || echo "no-head-tree"
    git diff HEAD -- "$target" 2>/dev/null || true
    # 未追跡ファイルは名前と中身の両方を混ぜる（名前だけだと中身の変更に反応しない）
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '%s ' "$f"
      git hash-object "$f" 2>/dev/null || echo "unreadable"
    done < <(git ls-files --others --exclude-standard -- "$target" 2>/dev/null || true)
  } | git hash-object --stdin 2>/dev/null || echo unknown
}
