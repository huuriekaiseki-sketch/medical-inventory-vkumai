#!/usr/bin/env bash
set -euo pipefail

# プラグイン v1 の生成（issue #420、docs/specs/plugin-v1/SPEC.md Part 2 セット C）。
# 正本は .claude/ と scripts/ のまま、層の表（scripts/lib/plugin-layout.json）に従って
# dist/plugins/aidd-core と dist/plugins/aidd-vkumai を機械生成する。本体は scripts/lib/build-plugin.mjs。
#
# 使い方:
#   bash scripts/build-plugin.sh            # dist/plugins/ を再生成する（決定的。差分が出たらコミットする）
#   bash scripts/build-plugin.sh --check    # 再生成せず、既存の dist/plugins/ が最新かを検査する（CI）
#   bash scripts/build-plugin.sh --out DIR  # 出力先を変える（検証用）
#
# 動作確認（受け入れ条件、SPEC Part 1）:
#   claude --plugin-dir "$PWD/dist/plugins/aidd-core" --plugin-dir "$PWD/dist/plugins/aidd-vkumai" ...
#   Workflow 名は修飾する: Workflow({ name: 'aidd-vkumai:aidd-phase1-router', ... })

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/lib/build-plugin.mjs" "$@"
