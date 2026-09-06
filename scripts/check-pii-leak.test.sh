#!/bin/bash
# WHY: issue #757 の 5（PII のログ流出検査）のうち「リポジトリに残る側」を機械検知する構造テスト。
#   (a) 追跡ファイルに、許可ドメイン以外のメールアドレスが無い（実在の人のアドレスが fixture・docs・
#       セッション記録・スクリーンショット名に混ざらない。.claude/rules/e2e-test-hygiene.md の
#       「実データを入れない」を機械化）
#   (b) ログ・テスト成果物・認証状態（logs/・test-results/・e2e/.auth/*.json）が gitignore されている
#       （AI エージェントの観測ログと Playwright の失敗時スクリーンショットは施設名・患者情報を含みうる）
#   (c) fixture 差し替えで (a) を検知できる（RED 方向の自己検証）
#
# サーバー側ログ（Vercel）の伏せ字は src/lib/log-safe.ts + eslint no-console が担い、
# 本物の DB エラーに患者情報が入ることの実測は pii-error-details.integration.test.ts が担う。
#
# 実行: bash scripts/check-pii-leak.test.sh
# 環境変数（テスト用注入ポイント）:
#   PII_SCAN_ROOT   走査するリポジトリ（既定はこのリポジトリ）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${PII_SCAN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 許可ドメイン: RFC 2606 の予約ドメイン、テスト用、コミット署名・GitHub、設計書の玩具例
ALLOWED_DOMAINS_RE='(example\.(com|org|net|test)|test\.com|anthropic\.com|github\.com|users\.noreply\.github\.com|b\.com|d\.com)'

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 追跡ファイル中のメールアドレスのうち、許可ドメイン以外を "path:line:email" で返す。$1=リポジトリ
scan_emails() {
  local root="$1"
  # ls-files はリポジトリ相対パスを返すので、grep は必ずそのリポジトリを cwd にして実行する
  # （cwd を変えずに走らせると全ファイルが見つからず、2>/dev/null で黙って「0 件」になる。RED fixture で踏んだ）
  (
    cd "$root" || exit 1
    git ls-files -z -- ':!package-lock.json' ':!*.svg' ':!*.png' ':!*.jpg' ':!*.ico' ':!*.woff' ':!*.woff2' \
      | xargs -0 grep -n -o -E -I '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- \
      | grep -v -i -E "@${ALLOWED_DOMAINS_RE}\$" || true
  )
}

echo "=== scenario 1: 追跡ファイルに許可ドメイン以外のメールアドレスが無い ==="
HITS="$(scan_emails "$REPO_ROOT")"
if [ -z "$HITS" ]; then
  assert_ok "許可ドメイン以外のメールアドレスなし"
else
  assert_fail "許可ドメイン以外のメールアドレスがある（実在の人なら削除、テスト用なら example.test 等へ）" "$HITS"
fi

echo "=== scenario 2: ログ・テスト成果物・認証状態は gitignore されている ==="
for p in logs/x.jsonl test-results/x.png e2e/.auth/user.json .env.local; do
  if git -C "$REPO_ROOT" check-ignore -q "$p"; then
    assert_ok "ignore: $p"
  else
    assert_fail "gitignore されていない: $p"
  fi
done

echo "=== scenario 3: fixture 差し替えで検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
git -C "$WORK_DIR" init -q
printf 'contact: ok@example.com\n' > "$WORK_DIR/ok.md"
printf 'leaked: real.person@gmail.com\n' > "$WORK_DIR/leak.md"
printf 'signed-off: noreply@anthropic.com\n' > "$WORK_DIR/sig.md"
git -C "$WORK_DIR" add -A
FIX_HITS="$(scan_emails "$WORK_DIR")"
if printf '%s\n' "$FIX_HITS" | grep -q 'leak.md:1:real.person@gmail.com'; then
  assert_ok "gmail.com を検知"
else
  assert_fail "gmail.com を検知できない" "$FIX_HITS"
fi
if printf '%s\n' "$FIX_HITS" | grep -q -e 'ok.md' -e 'sig.md'; then
  assert_fail "許可ドメインを誤検知" "$FIX_HITS"
else
  assert_ok "example.com / anthropic.com は許可"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
