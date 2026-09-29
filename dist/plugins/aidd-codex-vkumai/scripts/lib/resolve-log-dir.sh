#!/usr/bin/env bash
# 全worktreeで共有される logs/ ディレクトリの絶対パスを解決する（issue #546）。
#
# 背景: git worktreeは`.git`は共有するが、`logs/`は各scripts/log-*.sh・check-*.sh・
# summarize-*.shが自身の起動時カレントディレクトリ相対（"logs/xxx.jsonl"）で作るため、
# worktreeごとに別々の logs/ へ書き込んでいた。2026-07-26のOpus設計評価（issue #546の元）で
# 実測したところ、観測記録全319件中156件（49%）が6つのworktreeに死蔵しており、
# 新しいworktreeでは月次サマリ（gate-effectiveness-monthly-check.sh）が恒久的に無言になる
# 事象も確認された。
#
# `git rev-parse --git-common-dir` は同一リポジトリの全worktreeで共通の.gitディレクトリ
# （メインworktree側の実体）を指すため、その親ディレクトリをlogs/の基準にする。
# gitリポジトリでない場合（*.test.shのサンドボックス等）は、従来どおり呼び出し側の
# カレントディレクトリ相対の"logs"にフォールバックする（挙動を変えない）。
#
# 使い方: sourceしてから resolve_log_dir を呼ぶ（末尾スラッシュ無しのディレクトリパスを
# 1行返す。存在しなくてもよい。ディレクトリの作成は呼び出し側の責務のまま）。
#   source ".../lib/resolve-log-dir.sh"
#   LOG_FILE="$(resolve_log_dir)/loop-observability.jsonl"
#
# AIDD_LOG_DIR環境変数が設定されている場合は、git解決より優先してそれを返す
# （テスト・手動検証での明示的な差し替え用）。

resolve_log_dir() {
  if [[ -n "${AIDD_LOG_DIR:-}" ]]; then
    echo "$AIDD_LOG_DIR"
    return 0
  fi

  local common_git_dir
  if common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    echo "$(dirname "$common_git_dir")/logs"
    return 0
  fi

  echo "logs"
}
