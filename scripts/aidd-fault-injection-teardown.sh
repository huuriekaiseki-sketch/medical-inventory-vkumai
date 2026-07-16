#!/usr/bin/env bash
set -euo pipefail

# aidd-fault-injection-setup.sh で書き換えた .aidd/run-manifest.json を
# 訓練前の状態に戻すteardownスクリプト。詳細: docs/agents/fault-injection-drill.md

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="$REPO_ROOT/.aidd/run-manifest.json"
MANIFEST_BACKUP_PATH="$REPO_ROOT/.aidd/run-manifest.json.bak"

if [[ -f "$MANIFEST_BACKUP_PATH" ]]; then
  mv "$MANIFEST_BACKUP_PATH" "$MANIFEST_PATH"
else
  rm -f "$MANIFEST_PATH"
fi
