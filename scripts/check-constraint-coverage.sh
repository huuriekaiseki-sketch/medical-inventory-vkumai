#!/usr/bin/env bash
set -euo pipefail

# DB制約と認可経路の穴を機械検知する（warning-only）。#675 の再発防止 + #757 の 34。
#
# 1. cardinality        : 既存テーブルへ後付けしたFK列に、1対1(UNIQUE)か1対多かの宣言が無い
# 2. integrationCoverage: 制約を導入したのに、そのテーブルが実DB統合テストに一度も登場しない
# 3. rls / admin        : ポリシーがあるのに他人で叩いていない、admin限定なのに非adminで試していない
# 4. rpc                : クライアントから呼べるのに境界テストで一度も呼んでいない RPC（P-043）
#
# どちらも近似判定であり、ブロックせず警告のみ出す（docs/agents/actuator-inventory.md）。
# 誤検知だと判断した場合は、migration の SQL に理由付きのマーカーを書いて除外する:
#   -- cardinality: many <理由>
#   -- integration-coverage: not-required <理由>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 既定は人間向けの「怪しい順」レポート。--json で機械可読な生データを出す。
exec node "$REPO_ROOT/.claude/workflows/lib/constraint-coverage.js" "$@"
