#!/bin/bash
# WHY: issue #731。sweep recall ベンチマーク（issue #431）の fixture コードに
#      「issue #431 の recall ベンチマーク用 fixture。○○を意図的に再現」という自己申告コメントが
#      あると、sweep エージェントが欠陥に気づいた上で「意図的な fixture」と判断して指摘から外し、
#      MISS になる（2026-09-05 実測: コメント有り 0/1 → 同じ定義・同じモデルでコメント無し 1/1）。
#      fixture の説明は各 case の NOTES.md（clone 先へコピーされない）に置き、`files/` 配下のコードには
#      正体を明かす語を書かないことを機械検査する。
#
# 実行: bash scripts/check-eval-fixtures-neutral.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_ROOT="${EVAL_FIXTURES_NEUTRAL_ROOT:-$SCRIPT_DIR/eval-fixtures}"

# clone 先へコピーされる files/ 配下に現れてはいけない語。
# 「fixture」「ベンチマーク」「意図的」「recall」「issue #431」「再現」は、コードを読む側に
# 「これは評価用の仕込みで、本物の欠陥ではない」と教えてしまう
FORBIDDEN_PATTERN='fixture|ベンチマーク|benchmark|意図的|recall|issue #431|再現|eval-runs|known-failure-patterns'

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

scan() {
  # $1: fixtures root。files/ 配下のソースだけを見る（NOTES.md・expected.json・manifest.json は対象外）。
  # ファイル名（eval-fixture-recall 等）は対象外: import パスや識別子として本文に必ず現れるため
  find "$1" -path '*/files/*' -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' -o -name '*.js' \) -print0 \
    | xargs -0 grep -n -E -i "$FORBIDDEN_PATTERN" 2>/dev/null \
    | grep -v -E 'eval[-_]fixture[-_]recall' || true
}

echo "=== scenario 1: 実態の fixture コードに自己申告語が無い ==="
HITS="$(scan "$FIXTURES_ROOT")"
if [ -z "$HITS" ]; then
  ok "files/ 配下に自己申告語なし（$FIXTURES_ROOT）"
else
  ng "files/ 配下に自己申告語がある。説明は case ディレクトリの NOTES.md へ移すこと" "$HITS"
fi

echo "=== scenario 2: 各 case に NOTES.md がある（説明の置き場所を固定） ==="
for case_dir in "$FIXTURES_ROOT"/sweep-*/case-*/; do
  [ -d "$case_dir" ] || continue
  if [ -f "$case_dir/NOTES.md" ]; then
    ok "NOTES.md あり: $(basename "$(dirname "$case_dir")")/$(basename "$case_dir")"
  else
    ng "NOTES.md が無い: $case_dir"
  fi
done

echo "=== scenario 3: 自己申告コメントを仕込むと検知する（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sweep-x/case-1/files/src"
printf '// issue #431のrecallベンチマーク用fixture。認可チェック欠落を意図的に再現\nexport const x = 1\n' > "$WORK/sweep-x/case-1/files/src/a.ts"
RED_HITS="$(scan "$WORK")"
if [ -n "$RED_HITS" ]; then
  ok "仕込んだ自己申告コメントを検知"
else
  ng "自己申告コメントを検知できない（検査が空振り）"
fi

echo "=== scenario 4: ファイル名・import パス由来の eval-fixture-recall は誤検知しない ==="
mkdir -p "$WORK/sweep-y/case-1/files/src"
printf "import type { Item } from '@/types/eval-fixture-recall'\nexport const y = 1\n" > "$WORK/sweep-y/case-1/files/src/b.ts"
GREEN_HITS="$(scan "$WORK/sweep-y")"
if [ -z "$GREEN_HITS" ]; then
  ok "識別子・パスとしての eval-fixture-recall は許容"
else
  ng "識別子・パスを誤検知" "$GREEN_HITS"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
