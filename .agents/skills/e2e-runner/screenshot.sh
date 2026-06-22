#!/usr/bin/env bash
# E2E スクリーンショット撮影スクリプト（e2e-runner スキル同梱）
# Usage: ./screenshot.sh <url> <name>
#   url  : 撮影対象URL（例: http://localhost:3000/users）
#   name : 出力ファイル名（拡張子不要。screenshots/<name>.png に保存）
set -euo pipefail

URL="${1:?usage: ./screenshot.sh <url> <name>}"
NAME="${2:?usage: ./screenshot.sh <url> <name>}"

OUT_DIR="screenshots"
mkdir -p "$OUT_DIR"
OUT_PATH="${OUT_DIR}/${NAME}.png"

# Playwright CLI を利用（npx playwright が無ければ案内して終了）
if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx が見つかりません。Node.js / Playwright を導入してください。" >&2
  exit 1
fi

echo "📸 capturing ${URL} -> ${OUT_PATH}"
npx playwright screenshot --full-page "$URL" "$OUT_PATH"
echo "saved: ${OUT_PATH}"
