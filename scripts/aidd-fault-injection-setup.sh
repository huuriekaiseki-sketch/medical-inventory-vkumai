#!/usr/bin/env bash
set -euo pipefail

# aidd-phase2.js のdeny-by-defaultゲート（Spec Check / Manifest Check）が
# 実際にblockedを返すことを確認するfault injection訓練用のセットアップスクリプト。
# 詳細: docs/agents/fault-injection-drill.md

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_ROOT="$REPO_ROOT/.claude/workflows/__fixtures__/fault-injection"
MANIFEST_PATH="$REPO_ROOT/.aidd/run-manifest.json"
MANIFEST_BACKUP_PATH="$REPO_ROOT/.aidd/run-manifest.json.bak"

usage() {
  echo "Usage: $0 <scenario>" >&2
  echo "  scenario: missing-spec | missing-manifest | missing-approval | tampered-spechash" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  usage
fi

SCENARIO="$1"

case "$SCENARIO" in
  missing-spec|missing-manifest|missing-approval|tampered-spechash) ;;
  *)
    echo "unknown scenario: $SCENARIO" >&2
    exit 1
    ;;
esac

mkdir -p "$REPO_ROOT/.aidd"

if [[ -f "$MANIFEST_PATH" ]]; then
  cp "$MANIFEST_PATH" "$MANIFEST_BACKUP_PATH"
fi

case "$SCENARIO" in
  missing-spec)
    # ファイル自体を用意しない。存在しないダミーpathを出力するだけ。
    rm -f "$MANIFEST_PATH"
    echo ".claude/workflows/__fixtures__/fault-injection/missing-spec/SPEC.md"
    ;;
  missing-manifest)
    # 有効なSPEC.mdは存在するが run-manifest.json は無い状態を再現する。
    rm -f "$MANIFEST_PATH"
    echo ".claude/workflows/__fixtures__/fault-injection/missing-manifest/SPEC.md"
    ;;
  missing-approval)
    cp "$FIXTURE_ROOT/missing-approval/run-manifest.json" "$MANIFEST_PATH"
    echo ".claude/workflows/__fixtures__/fault-injection/missing-approval/SPEC.md"
    ;;
  tampered-spechash)
    cp "$FIXTURE_ROOT/tampered-spechash/run-manifest.json" "$MANIFEST_PATH"
    echo ".claude/workflows/__fixtures__/fault-injection/tampered-spechash/SPEC.md"
    ;;
esac
