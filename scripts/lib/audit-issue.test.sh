#!/bin/bash
# WHY: scripts/lib/audit-issue.sh の回帰テスト（issue #876）。gh をスタブに差し替え、
#      - 脆弱性が見つかったら `[audit] npm`（label security）を作る／追記する
#      - audit 自体が失敗した（レジストリ・ネットワーク・lockfile 不在）ときは `[env] npm audit` に分ける
#      - 出力を読めない・終了コードと中身が食い違うときも黙らない
#      を見る。fixture の JSON は 2026-10-02 に npm 11.19.0 で実際に出した形
#      （脆弱性あり = 78eeb612 の lockfile、失敗 = lockfile の無いディレクトリ）。
#
# 実行: bash scripts/lib/audit-issue.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/audit-issue.sh"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if grep -qF -- "$2" <<<"$1"; then assert_ok "$3"; else assert_fail "$3" "expected: $2"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then assert_fail "$3" "unexpected: $2"; else assert_ok "$3"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# gh スタブ: 呼び出しを記録し、issue list は環境変数 STUB_OPEN_ISSUES の JSON を返す
cat > "$WORK/gh" <<'EOF'
#!/bin/bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "issue list") printf '%s' "${STUB_OPEN_ISSUES:-[]}" ;;
  "issue create"|"issue comment")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--body-file" ]; then cat "$2" >> "$STUB_LOG.body"; fi
      shift
    done
    ;;
esac
EOF
chmod +x "$WORK/gh"

cat > "$WORK/vuln.json" <<'EOF'
{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "next": {
      "name": "next",
      "severity": "critical",
      "isDirect": true,
      "via": [
        {
          "source": 1240609,
          "name": "next",
          "dependency": "next",
          "title": "Next.js: Remote Code Execution in next/og ImageResponse",
          "url": "https://github.com/advisories/GHSA-vcvr-r3jv-pc5j",
          "severity": "critical",
          "range": ">=16.2.0 <16.3.6"
        }
      ],
      "effects": [],
      "range": "16.2.0 - 16.3.5",
      "nodes": ["node_modules/next"],
      "fixAvailable": { "name": "next", "version": "16.3.8", "isSemVerMajor": false }
    },
    "minimist": {
      "name": "minimist",
      "severity": "moderate",
      "isDirect": false,
      "via": [{ "title": "moderate のものは issue に載せない", "url": "https://example.invalid/moderate", "severity": "moderate" }],
      "effects": [],
      "range": "<1.2.6",
      "nodes": ["node_modules/minimist"],
      "fixAvailable": true
    }
  },
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 1, "high": 0, "critical": 1, "total": 2 }
  }
}
EOF

cat > "$WORK/error.json" <<'EOF'
{
  "error": {
    "code": "ENOLOCK",
    "summary": "This command requires an existing lockfile.",
    "detail": "Try creating one first with: npm i --package-lock-only"
  }
}
EOF

run() {
  # $1 = ログ名, $2 = STATUS, $3 = 入力, $4 = 既存の open issue（JSON）
  export STUB_LOG="$WORK/$1"
  : > "$STUB_LOG"
  AUDIT_GH_BIN="$WORK/gh" STUB_OPEN_ISSUES="${4:-[]}" STATUS="$2" bash "$TARGET" "$3" 2>&1
}

echo "=== scenario 1: high 以上の脆弱性があれば [audit] npm を security ラベルで作る ==="
OUT="$(run log1 1 "$WORK/vuln.json")"
assert_contains "$OUT" "issue を作成: [audit] npm" "create の経路"
assert_contains "$(cat "$WORK/log1")" "issue create --title [audit] npm --label security" "題名とラベル"
BODY="$(cat "$WORK/log1.body")"
assert_contains "$BODY" "GHSA-vcvr-r3jv-pc5j" "advisory の URL を載せる"
assert_contains "$BODY" "critical" "重大度を載せる"
assert_contains "$BODY" "16.3.8" "修正版を載せる"
assert_contains "$BODY" "16.2.0 - 16.3.5" "当たっている範囲を載せる"
assert_not_contains "$BODY" "moderate のものは issue に載せない" "閾値（high）未満は載せない"

echo "=== scenario 2: 同じ題名の open issue があれば追記（似た題名は既存扱いしない） ==="
OUT="$(run log2 1 "$WORK/vuln.json" '[{"number":42,"title":"[audit] npm"},{"number":7,"title":"[audit] npm-old"}]')"
assert_contains "$OUT" "issue #42 に追記" "完全一致の題名だけを既存扱い"
assert_contains "$(cat "$WORK/log2")" "issue comment 42 --body-file" "gh issue comment を呼ぶ"
if grep -q "issue create" "$WORK/log2"; then assert_fail "既存があるのに create した"; else assert_ok "create しない"; fi

echo "=== scenario 3: audit 自体の失敗は [env] npm audit に分ける（脆弱性の有無は分かっていない） ==="
OUT="$(run log3 1 "$WORK/error.json")"
assert_contains "$OUT" "issue を作成: [env] npm audit" "題名を分ける"
assert_contains "$(cat "$WORK/log3")" "--label bug" "security ラベルは付けない"
BODY="$(cat "$WORK/log3.body")"
assert_contains "$BODY" "ENOLOCK" "失敗のコードを載せる"
assert_contains "$BODY" "脆弱性の有無は分かっていない" "合格とも違反とも読ませない"

echo "=== scenario 4: 出力を読めないときも黙らない ==="
printf 'npm ERR! something\n' > "$WORK/garbage.json"
OUT="$(run log4 1 "$WORK/garbage.json")"
assert_contains "$OUT" "issue を作成: [env] npm audit" "読めない出力は [env] に倒す"
assert_contains "$(cat "$WORK/log4.body")" "読めなかった" "読めなかったと書く"
: > "$WORK/empty.json"
OUT="$(run log4b 1 "$WORK/empty.json")"
assert_contains "$OUT" "issue を作成: [env] npm audit" "空の出力も [env] に倒す"

echo "=== scenario 5: 終了コードが 0 でないのに high 以上が無い（食い違い）も黙らない ==="
printf '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0}}}' > "$WORK/clean.json"
OUT="$(run log5 1 "$WORK/clean.json")"
assert_contains "$OUT" "issue を作成: [env] npm audit" "食い違いは [env] に倒す"
assert_contains "$(cat "$WORK/log5.body")" "食い違い" "食い違いと書く"

echo "=== scenario 6: 入力の不備は exit 1 ==="
set +e
AUDIT_GH_BIN="$WORK/gh" STATUS=1 bash "$TARGET" "$WORK/missing.json" >/dev/null 2>&1
s1=$?
AUDIT_GH_BIN="$WORK/gh" bash "$TARGET" "$WORK/vuln.json" >/dev/null 2>&1
s2=$?
set -e
if [ "$s1" -ne 0 ]; then assert_ok "入力ファイルが無ければ失敗"; else assert_fail "入力ファイルが無いのに成功"; fi
if [ "$s2" -ne 0 ]; then assert_ok "STATUS 未指定で失敗"; else assert_fail "STATUS 未指定なのに成功"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
