#!/usr/bin/env bash
set -euo pipefail

# DB制約に関する2つの穴を機械検知する（warning-only）。#675 の再発防止。
#
# 1. cardinality        : 既存テーブルへ後付けしたFK列に、1対1(UNIQUE)か1対多かの宣言が無い
# 2. integrationCoverage: 制約を導入したのに、そのテーブルが実DB統合テストに一度も登場しない
#
# どちらも近似判定であり、ブロックせず警告のみ出す（docs/agents/actuator-inventory.md）。
# 誤検知だと判断した場合は、migration の SQL に理由付きのマーカーを書いて除外する:
#   -- cardinality: many <理由>
#   -- integration-coverage: not-required <理由>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 既定は人間向けの「怪しい順」レポート。--json で機械可読な生データを出す。
exec node "$REPO_ROOT/.claude/workflows/lib/constraint-coverage.js" "$@"
