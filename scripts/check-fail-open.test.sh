#!/bin/bash
# WHY: issue #757 の 31（fail-open の総点検、製品側）。docs/agents/fail-open-inventory.md の方針
#      「認可・認証・MFA の判定は、エラーを拒否と同一視する」を機械で固定する。
#   (a) src/（テスト除く）で `await …rpc(` / `await …auth.getUser(` / `await …auth.mfa.*` している行は
#       必ず `error` を受け取る（`{ data, error }` の error を捨てると、判定材料が取れないときに
#       「通す」経路になりうる。2026-09-06 に proxy の MFA ガードで実際に起きていた）
#   (b) 棚卸しの表（F-xxx）の「守るテスト」列に書かれたパスが実在する
#   (c) 表の列数・ID 規約・状態 3 語（閉じる / 情報のみ / 開く）。「開く」は残してはいけない
#   (d) fixture で (a) と (c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-fail-open.test.sh
# 環境変数（テスト用注入ポイント）:
#   FAIL_OPEN_SRC_ROOT        走査する src（既定 <repo>/src）
#   FAIL_OPEN_INVENTORY_PATH  棚卸しの表（既定 docs/agents/fail-open-inventory.md）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_ROOT="${FAIL_OPEN_SRC_ROOT:-$REPO_ROOT/src}"
INVENTORY="${FAIL_OPEN_INVENTORY_PATH:-$REPO_ROOT/docs/agents/fail-open-inventory.md}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# (a) error を受け取っていない判定呼び出しを "path:line: code" で返す。$1=src ルート
scan_dropped_errors() {
  local root="$1"
  grep -rn -E "await [A-Za-z_.]*(\.rpc\(|\.auth\.getUser\(|\.auth\.mfa\.)" "$root" \
    --include='*.ts' --include='*.tsx' --exclude-dir='__tests__' --exclude='*.test.ts' --exclude='*.test.tsx' 2>/dev/null \
    | grep -v -E "error" \
    | sed "s#^$root/##" || true
}

# (b)(c) 棚卸しの表の検査。$1=表。末尾行に violations=N
check_inventory() {
  local file="$1" violations=0 line id nf status tests p
  if [ ! -f "$file" ]; then
    echo "    missing: $file"
    echo "violations=1"
    return
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    # セル内の `\|`（エスケープ済み縦棒）は列区切りではない
    nf="$(printf '%s' "$line" | sed 's/\\|//g' | awk -F'|' '{print NF}')"
    if [ "$nf" -ne 8 ]; then
      echo "    columns: [$id] 列数が6列でない（区切り数=$((nf-1))）"
      violations=$((violations+1))
      continue
    fi
    if ! printf '%s' "$id" | grep -qE '^F-[0-9]{3}$'; then
      echo "    id: [$id] ID が F-3桁でない"
      violations=$((violations+1))
    fi
    status="$(printf '%s' "$line" | sed 's/\\|//g' | awk -F'|' '{gsub(/^ +| +$/,"",$6); print $6}')"
    tests="$(printf '%s' "$line" | sed 's/\\|//g' | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"
    case "$status" in
      閉じる|"閉じる（UI）"|情報のみ) ;;
      開く) echo "    open: [$id] 状態が「開く」のまま（直すか、理由と #757-N を付けて閉じる）"; violations=$((violations+1)) ;;
      *) echo "    status: [$id] 状態が3語以外: '$status'"; violations=$((violations+1)) ;;
    esac
    # 角括弧（[id] を含むパス）も許す。POSIX の括弧式では ] を先頭に置く
    for p in $(printf '%s' "$tests" | grep -o '`[][A-Za-z0-9_./-]*`' | tr -d '`'); do
      case "$p" in
        */|*.ts|*.tsx|*.sh|*.md|*.sql)
          if [ ! -e "$REPO_ROOT/$p" ]; then
            echo "    path: [$id] 守るテストのパスが存在しない: $p"
            violations=$((violations+1))
          fi
          ;;
      esac
    done
  done < <(grep '^| F-' "$file" || true)
  echo "violations=$violations"
}

echo "=== scenario 1: src/ の認可・認証・MFA 呼び出しは error を受け取っている ==="
DROPPED="$(scan_dropped_errors "$SRC_ROOT")"
if [ -z "$DROPPED" ]; then
  assert_ok "error を捨てている判定呼び出しなし"
else
  assert_fail "error を捨てている判定呼び出しがある（判定材料が取れないときに通る経路になりうる。docs/agents/fail-open-inventory.md の方針）" "$DROPPED"
fi

echo "=== scenario 2: 棚卸しの表（F-xxx）に違反が無い ==="
RESULT="$(check_inventory "$INVENTORY")"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし（$(grep -c '^| F-' "$INVENTORY" || echo 0) 行）"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/lib" "$WORK/src/__tests__"
cat > "$WORK/src/lib/bad.ts" <<'EOF'
export async function a(db: any) {
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel()
  const { data } = await db.rpc('is_facility_member', { p_facility_id: 'x' })
  const { data: { user } } = await db.auth.getUser()
  return [aal, data, user]
}
EOF
cat > "$WORK/src/lib/good.ts" <<'EOF'
export async function b(db: any) {
  const { data, error } = await db.rpc('is_facility_member', { p_facility_id: 'x' })
  const { data: aal, error: aalError } = await db.auth.mfa.getAuthenticatorAssuranceLevel()
  const rows = await db.from('x').select('*')
  return [data, error, aal, aalError, rows]
}
EOF
cat > "$WORK/src/__tests__/ignored.test.ts" <<'EOF'
const { data } = await db.rpc('is_facility_member')
EOF
DROPPED="$(scan_dropped_errors "$WORK/src")"
if [ "$(printf '%s\n' "$DROPPED" | grep -c 'lib/bad.ts')" -eq 3 ]; then assert_ok "error を捨てた 3 行をちょうど検知"; else assert_fail "検知数が違う" "$DROPPED"; fi
if printf '%s\n' "$DROPPED" | grep -q 'good.ts'; then assert_fail "error を受け取っている行を誤検知" "$DROPPED"; else assert_ok "error を受け取っている行・rpc 以外の呼び出しは誤検知しない"; fi
if printf '%s\n' "$DROPPED" | grep -q 'ignored.test.ts'; then assert_fail "テストを走査した"; else assert_ok "テストは走査しない"; fi

cat > "$WORK/inventory.md" <<'EOF'
| F-900 | 正常 | x | `error \|\| !data` で拒否 | 閉じる | `package.json` |
| F-901 | 開いたまま | x | 通る | 開く | `package.json` |
| F-902 | 状態が変 | x | y | たぶん閉じる | `package.json` |
| F-903 | 不在パス | x | y | 閉じる | `scripts/no-such-test.sh` |
| F-12 | 桁不足 | x | y | 閉じる | `package.json` |
| F-904 | 列ずれ | x | 閉じる | `package.json` |
EOF
RESULT="$(check_inventory "$WORK/inventory.md")"
EXPECTED=5
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（$EXPECTED）と異なる" "$RESULT"
fi
for needle in 'open: \[F-901\]' 'status: \[F-902\]' 'path: \[F-903\]' 'id: \[F-12\]' 'columns: \[F-904\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q 'F-900'; then assert_fail "正常行（エスケープ済み縦棒を含む）を誤検知" "$RESULT"; else assert_ok "正常行は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
