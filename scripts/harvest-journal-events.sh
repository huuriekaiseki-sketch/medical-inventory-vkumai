#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #642。Workflow journal(~/.claude/projects/配下のwf_*)はtranscript cleanupで
# 消えるため(実測で3ディレクトリしか残存していなかった)、Stop hook契機で毎回、消える前に
# logs/journal-harvest.jsonl(全worktree共有のresolve_log_dir()配下)へ収穫しておく。
# 重複はsource+agentIdで排除される(scripts/lib/harvest-journal-events.ts参照)ため、
# 毎回実行しても追記は差分のみ。
#
# projectDirはメインworktree固定にしない: worktreeで走るセッションのjournalは
# 「-Users-...-vkumai--claude-worktrees-<name>」という別のprojectディレクトリに書かれるため、
# リポジトリのメインworktreeパスをsanitizeしたprefixに前方一致する全projectディレクトリを
# 走査して1つずつ収穫する(重複はTS側のsource+agentIdキーで排除される)。
#
# 使い方: scripts/harvest-journal-events.sh [--project-dir PATH]
# fail-open: 収穫はあくまで観測のための副次処理なので、npx/tsx不在等で失敗しても
# 呼び出し元(Stop hook)は落とさない。ただし単体実行時は失敗を見えるようにexit codeは返す。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

OUTPUT_FILE="$(resolve_log_dir)/journal-harvest.jsonl"

CLI_PROJECT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) CLI_PROJECT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# 優先順: CLI引数 > AIDD_JOURNAL_PROJECT_DIR(テスト・手動検証での差し替え用。
# resolve-log-dir.shのAIDD_LOG_DIRと同じ流儀) > リポジトリ対応の全projectディレクトリ走査。
PROJECT_DIRS=()
if [[ -n "$CLI_PROJECT_DIR" ]]; then
  PROJECT_DIRS=("$CLI_PROJECT_DIR")
elif [[ -n "${AIDD_JOURNAL_PROJECT_DIR:-}" ]]; then
  PROJECT_DIRS=("$AIDD_JOURNAL_PROJECT_DIR")
else
  # Claude Codeのprojectディレクトリ名はワーキングディレクトリの非英数字を'-'に置換したもの。
  # メインworktreeのパスから求めたprefixで前方一致させ、worktreeセッション分も拾う。
  if MAIN_GIT_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    MAIN_ROOT="$(dirname "$MAIN_GIT_DIR")"
    PREFIX="$(printf '%s' "$MAIN_ROOT" | sed 's/[^a-zA-Z0-9]/-/g')"
    for dir in "$HOME/.claude/projects/$PREFIX"*/; do
      [[ -d "$dir" ]] && PROJECT_DIRS+=("${dir%/}")
    done
  fi
fi

if [[ ${#PROJECT_DIRS[@]} -eq 0 ]]; then
  echo "収穫対象のprojectディレクトリが見つかりません" >&2
  exit 1
fi

# WHY: 以前は `npx -y tsx` で実行していたが、tsx は devDependencies に無く npx が毎回 npm レジストリへ
#      取りに行く。CI の hooks-test（node_modules 無し）ではレジストリが遅い日に 1 回 7 分かかった
#      （2026-09-04 実測。平常時 51 秒 → 425 秒）。Node 22.6+ / 24 標準の型除去で直接実行し、
#      ネットワーク依存を無くす。ランナー既定の Node 22 では警告が出るため --no-warnings を付ける。
for project_dir in "${PROJECT_DIRS[@]}"; do
  node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/harvest-journal-events.ts" --output "$OUTPUT_FILE" --project-dir "$project_dir"
done
