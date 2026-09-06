#!/bin/bash
# WHY: Claude Code は compaction 後に「起動済みスキル本文」を再注入するが、1スキルあたり
#      5,000 トークンで打ち切る（先頭を残して末尾を捨てる。公式 context-window ドキュメント
#      「What survives compaction」）。handoff-format のように作業終盤（= compaction 後に
#      なりやすい）で使うスキルの末尾が切れると、Stop hook（check-handoff-format.sh）が
#      検知する必須見出しや 4 値規約が消え、警告ループの原因になる。
#
#      トークン数は環境によって API を叩けないため、「1文字=1トークン」の最悪ケースで
#      文字数を上限とみなす（issue #716 の実測: 日本語 1〜2 文字/トークン、ASCII 3〜4 文字/
#      トークンなので、5,000 文字未満なら tokenizer によらず上限内）。バイト数は日本語で
#      1 文字 3 バイトになりトークンの指標にならないので使わない。
#
#      対象は Claude 側 .claude/skills/ と Codex 側ミラー .agents/skills/ の両方
#      （scripts/lib/claude-codex-skills-parity.test.ts が「同じスキル群」と定義している）。
#
# 見つけられること: SKILL.md 本文が最悪ケース換算で再注入上限を超えたこと
# 見つけられないこと: 上限内でも重要指示が末尾に偏っていて要約で薄れるケース（内容の問題）
#
# 実行: bash scripts/check-skill-size.test.sh
# 環境変数（テスト用注入ポイント）:
#   SKILL_DIRS        スキルディレクトリ（スペース区切り。既定 .claude/skills .agents/skills）
#   SKILL_CHAR_LIMIT  文字数上限（既定 5000）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIMIT="${SKILL_CHAR_LIMIT:-5000}"
DIRS="${SKILL_DIRS:-$REPO_ROOT/.claude/skills $REPO_ROOT/.agents/skills}"

command -v jq >/dev/null 2>&1 || { echo "jq が必要です"; exit 1; }

fail=0
checked=0

# 文字数（Unicode コードポイント数）。wc -m はロケール依存で、C ロケールだとバイト数を返す
# 環境があるため、jq の string length（コードポイント数）を使う。
count_chars() {
  jq -Rs 'length' "$1"
}

for dir in $DIRS; do
  [ -d "$dir" ] || { echo "  SKIP: $dir が無い"; continue; }
  for skill in "$dir"/*/SKILL.md; do
    [ -f "$skill" ] || continue
    checked=$((checked + 1))
    chars="$(count_chars "$skill")"
    rel="${skill#"$REPO_ROOT"/}"
    if [ "$chars" -gt "$LIMIT" ]; then
      echo "  NG: $rel は ${chars} 文字（上限 ${LIMIT}）。compaction 再注入で末尾が切れる恐れがあります。最重要の指示を冒頭に寄せ、事例・経緯は references/ へ分離してください（issue #716）"
      fail=1
    else
      echo "  OK: $rel ${chars} 文字（上限 ${LIMIT}）"
    fi
  done
done

if [ "$checked" -eq 0 ]; then
  echo "  NG: 検査対象の SKILL.md が 1 つも見つかりませんでした（SKILL_DIRS=$DIRS）"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
