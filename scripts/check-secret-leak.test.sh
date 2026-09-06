#!/bin/bash
# WHY: issue #757 の 10（秘密情報と出口側）のうち「リポジトリと公開ビルドに秘密が混ざらない」を機械検知する。
#   (a) 追跡ファイルに秘密らしい文字列が無い（Supabase の JWT / sb_secret_ / sbp_ アクセストークン、
#       秘密鍵、AWS・GitHub・Slack・OpenAI/Anthropic のトークン）。anon key も JWT なので同じ網に掛かる
#       （anon key は公開値だが、コミットせず環境変数で渡す運用を機械化する）
#   (b) SUPABASE_SERVICE_ROLE_KEY はサーバー側だけが参照する。'use client' のファイル・src/components・
#       NEXT_PUBLIC_ 接頭辞での参照は、公開バンドルに service role が入る経路なので拒否する
#   (c) .env / .env.local / .env.test は gitignore されている（.env.test.example だけ追跡）
#   (d) fixture 差し替えで (a)(b) を検知できる（RED 方向の自己検証）
#
# 見つけられないもの: git 履歴に過去に入った秘密（履歴の走査は別途 gitleaks 等）、暗号化・難読化された値、
# パターンに無い独自形式のトークン。鍵のローテーション実測は #757 の 29。
#
# 実行: bash scripts/check-secret-leak.test.sh
# 環境変数（テスト用注入ポイント）:
#   SECRET_SCAN_ROOT   走査するリポジトリ（既定はこのリポジトリ）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SECRET_SCAN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 秘密らしい文字列のパターン（ERE）。この script 自身は追跡ファイルなので、パターンがパターン自身に
# 一致しない形（文字クラス・量指定子）で書く
SECRET_PATTERNS=(
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}'   # JWT（Supabase anon / service_role key）
  'sb_secret_[A-Za-z0-9_-]{10,}'                   # Supabase secret key（新形式）
  'sbp_[a-f0-9]{40}'                               # Supabase personal access token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'             # 秘密鍵
  'AKIA[0-9A-Z]{16}'                               # AWS access key id
  'ghp_[A-Za-z0-9]{36}'                            # GitHub PAT（classic）
  'github_pat_[A-Za-z0-9_]{22,}'                   # GitHub PAT（fine-grained）
  'xox[baprs]-[0-9A-Za-z-]{10,}'                   # Slack token
  'sk-(ant-)?[A-Za-z0-9_-]{20,}'                   # OpenAI / Anthropic API key
)

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# (a) 追跡ファイル中の秘密らしい文字列を "path:line:match" で返す。$1=リポジトリ
scan_secrets() {
  local root="$1" p
  (
    cd "$root" || exit 1
    for p in "${SECRET_PATTERNS[@]}"; do
      git ls-files -z -- ':!package-lock.json' \
        | xargs -0 grep -n -o -E -I -- "$p" 2>/dev/null || true
    done
  )
}

# (b) service role key を参照してはいけない場所からの参照を返す。$1=リポジトリ
scan_service_role_refs() {
  local root="$1" f
  (
    cd "$root" || exit 1
    git ls-files -z -- 'src/**' \
      | xargs -0 grep -l -- 'SUPABASE_SERVICE_ROLE_KEY' 2>/dev/null \
      | while IFS= read -r f; do
          case "$f" in
            src/components/*) echo "$f: src/components からの参照" ;;
            *) if grep -q -E "^['\"]use client['\"]" "$f"; then echo "$f: 'use client' のファイルからの参照"; fi ;;
          esac
        done
    git ls-files -z \
      | xargs -0 grep -n -o -E -I -- 'NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE[A-Z_]*' 2>/dev/null || true
  )
}

echo "=== scenario 1: 追跡ファイルに秘密らしい文字列が無い ==="
HITS="$(scan_secrets "$REPO_ROOT")"
if [ -z "$HITS" ]; then
  assert_ok "秘密らしい文字列なし"
else
  assert_fail "秘密らしい文字列がある（環境変数へ移し、漏れたものはローテーションする）" "$HITS"
fi

echo "=== scenario 2: service role key はサーバー側だけが参照する ==="
REFS="$(scan_service_role_refs "$REPO_ROOT")"
if [ -z "$REFS" ]; then
  assert_ok "client 側・NEXT_PUBLIC_ からの参照なし"
else
  assert_fail "公開バンドルに service role が入る経路がある" "$REFS"
fi
if git -C "$REPO_ROOT" ls-files --error-unmatch src/lib/supabase/server.ts > /dev/null 2>&1 \
   && grep -q 'SUPABASE_SERVICE_ROLE_KEY' "$REPO_ROOT/src/lib/supabase/server.ts"; then
  assert_ok "参照はサーバー用モジュール（src/lib/supabase/server.ts）にある"
else
  assert_fail "サーバー用モジュールが service role を参照していない（構成が変わったらこの検査も更新する）"
fi

echo "=== scenario 3: env ファイルは gitignore され、example だけ追跡されている ==="
for p in .env .env.local .env.test .env.production; do
  if git -C "$REPO_ROOT" check-ignore -q "$p"; then
    assert_ok "ignore: $p"
  else
    assert_fail "gitignore されていない: $p"
  fi
done
if git -C "$REPO_ROOT" ls-files --error-unmatch .env.test.example > /dev/null 2>&1; then
  assert_ok "追跡: .env.test.example（中身は scenario 1 の網で検査）"
else
  assert_fail ".env.test.example が追跡されていない"
fi

echo "=== scenario 4: fixture 差し替えで検知できる（RED 方向の自己検証） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
git -C "$WORK_DIR" init -q
mkdir -p "$WORK_DIR/src/components" "$WORK_DIR/src/lib/supabase"
# 偽の JWT（ヘッダ.ペイロード の形だけ再現。実在の鍵ではない）
FAKE_JWT="eyJ$(printf 'a%.0s' $(seq 1 30)).eyJ$(printf 'b%.0s' $(seq 1 30))"
printf 'SUPABASE_KEY=%s\n' "$FAKE_JWT" > "$WORK_DIR/leak.env.example"
printf -- '-----BEGIN %s KEY-----\nabc\n' 'PRIVATE' > "$WORK_DIR/key.pem.txt"
printf "'use client'\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY\n" > "$WORK_DIR/src/components/Bad.tsx"
printf 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY\n' > "$WORK_DIR/src/lib/supabase/server.ts"
printf 'const ok = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY\n' > "$WORK_DIR/src/lib/supabase/client.ts"
git -C "$WORK_DIR" add -A
FIX_SECRETS="$(scan_secrets "$WORK_DIR")"
if printf '%s\n' "$FIX_SECRETS" | grep -q 'leak.env.example:1:'; then assert_ok "JWT を検知"; else assert_fail "JWT を検知できない" "$FIX_SECRETS"; fi
if printf '%s\n' "$FIX_SECRETS" | grep -q 'key.pem.txt:1:'; then assert_ok "秘密鍵を検知"; else assert_fail "秘密鍵を検知できない" "$FIX_SECRETS"; fi
if printf '%s\n' "$FIX_SECRETS" | grep -q 'client.ts'; then assert_fail "anon key の環境変数名を誤検知" "$FIX_SECRETS"; else assert_ok "環境変数名だけの参照は検知しない"; fi
FIX_REFS="$(scan_service_role_refs "$WORK_DIR")"
if printf '%s\n' "$FIX_REFS" | grep -q 'src/components/Bad.tsx'; then assert_ok "client 側の service role 参照を検知"; else assert_fail "client 側の参照を検知できない" "$FIX_REFS"; fi
if printf '%s\n' "$FIX_REFS" | grep -q 'server.ts'; then assert_fail "サーバー側の参照を誤検知" "$FIX_REFS"; else assert_ok "サーバー側の参照は許可"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
