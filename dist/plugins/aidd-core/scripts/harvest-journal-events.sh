#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #642。Workflow journal(~/.claude/projects/配下のwf_*)はtranscript cleanupで
# 消えるため(実測で3ディレクトリしか残存していなかった)、Stop hook契機で毎回、消える前に
# logs/journal-harvest.jsonl(全worktree共有のresolve_log_dir()配下)へ収穫しておく。
# 重複はsource+agentIdで排除される(scripts/lib/harvest-journal-events.ts参照)ため、
# 毎回実行しても追記は差分のみ。
#
# projectDirはメインworktree固定にしない: worktreeで走るセッションのjournalは
# 「-Users-...-<repo>--claude-worktrees-<name>」という別のprojectディレクトリに書かれるため、
# リポジトリのメインworktreeパスをsanitizeしたprefixに前方一致する全projectディレクトリを
# 走査して1つずつ収穫する(重複はTS側のsource+agentIdキーで排除される)。
#
# WHY(issue #738、2026-09-05): 上記の全走査は project dir が増えるほど重くなる（実測 43 dir、
# 毎 Stop 2.8 秒・node 起動 43 回、追記 0 件）。前回収穫時刻（state ファイルの mtime）より新しい
# ファイルを wf_* 配下に持つ dir だけ node を起動し、それ以外は読まずに飛ばす。収穫 0 件の dir は
# 出力しない（以前は「0件追記」が dir 数ぶん stdout に並んでいた）。state ファイルは走査の最後に
# touch する（途中で落ちても次回は前回時刻から再走査するので取りこぼさない）。
#
# 使い方: scripts/harvest-journal-events.sh [--project-dir PATH] [--force]
#   --force  mtime による間引きをせず全 dir を走査する（手動の全量再収穫用）
# 環境変数:
#   AIDD_JOURNAL_PROJECT_DIR  テスト・手動検証での project dir 差し替え（resolve-log-dir.sh の AIDD_LOG_DIR と同じ流儀）
#   HARVEST_STATE_FILE        前回収穫時刻の記録先（既定 <log dir>/.journal-harvest-last-run）
#   HARVEST_VERBOSE=1         dir ごとの「走査 / スキップ」を stderr に出す（テスト・調査用）
# fail-open: 収穫はあくまで観測のための副次処理なので、npx/tsx不在等で失敗しても
# 呼び出し元(Stop hook)は落とさない。ただし単体実行時は失敗を見えるようにexit codeは返す。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_DIR="$(resolve_log_dir)"
OUTPUT_FILE="$LOG_DIR/journal-harvest.jsonl"
STATE_FILE="${HARVEST_STATE_FILE:-$LOG_DIR/.journal-harvest-last-run}"

CLI_PROJECT_DIR=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) CLI_PROJECT_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
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

# dir に前回収穫より新しい wf_* 配下のファイルがあるか（state が無ければ全 dir 対象）
has_new_files() {
  local dir="$1"
  if [[ "$FORCE" -eq 1 || ! -f "$STATE_FILE" ]]; then
    return 0
  fi
  [[ -n "$(find "$dir" -path '*/wf_*' -type f -newer "$STATE_FILE" -print -quit 2>/dev/null)" ]]
}

# WHY: 以前は `npx -y tsx` で実行していたが、tsx は devDependencies に無く npx が毎回パッケージレジストリへ
#      取りに行く。CI の hooks-test（node_modules 無し）ではレジストリが遅い日に 1 回 7 分かかった
#      （2026-09-04 実測。平常時 51 秒 → 425 秒）。Node 22.6+ / 24 標準の型除去で直接実行し、
#      ネットワーク依存を無くす。ランナー既定の Node 22 では警告が出るため --no-warnings を付ける。
# WHY: state に記録する時刻は「走査開始時刻」にする。走査終了時刻にすると、走査中に書かれた
#      ファイルが state より古くなり、次回スキップされて取りこぼす。開始時刻なら走査中の書き込みは
#      必ず state より新しく、次回もう一度拾われる（重複は TS 側の source+agentId で排除される）
START_MARK="$(mktemp "${TMPDIR:-/tmp}/.journal-harvest-start.XXXXXX")"
SCANNED=0
SKIPPED=0
TOTAL_APPENDED=0
for project_dir in "${PROJECT_DIRS[@]}"; do
  if ! has_new_files "$project_dir"; then
    SKIPPED=$((SKIPPED + 1))
    [[ "${HARVEST_VERBOSE:-}" = "1" ]] && echo "journal harvest: スキップ（前回以降の更新なし） $project_dir" >&2
    continue
  fi
  SCANNED=$((SCANNED + 1))
  [[ "${HARVEST_VERBOSE:-}" = "1" ]] && echo "journal harvest: 走査 $project_dir" >&2
  RESULT="$(node --experimental-strip-types --no-warnings "$SCRIPT_DIR/lib/harvest-journal-events.ts" --output "$OUTPUT_FILE" --project-dir "$project_dir")"
  APPENDED="$(printf '%s' "$RESULT" | sed -n 's/^journal harvest: \([0-9][0-9]*\)件追記.*/\1/p')"
  case "$APPENDED" in
    ''|*[!0-9]*) APPENDED=0 ;;
  esac
  if [[ "$APPENDED" -gt 0 ]]; then
    echo "$RESULT"
    TOTAL_APPENDED=$((TOTAL_APPENDED + APPENDED))
  fi
done

# 走査が最後まで通ったときだけ state を進める（途中で node が失敗すれば set -e で抜け、次回再走査）。
# state の mtime は走査開始時刻（START_MARK の作成時刻）
mkdir -p "$(dirname "$STATE_FILE")"
mv "$START_MARK" "$STATE_FILE"

if [[ "${HARVEST_VERBOSE:-}" = "1" ]]; then
  echo "journal harvest: 走査 ${SCANNED} dir / スキップ ${SKIPPED} dir / 追記 ${TOTAL_APPENDED} 件" >&2
fi
