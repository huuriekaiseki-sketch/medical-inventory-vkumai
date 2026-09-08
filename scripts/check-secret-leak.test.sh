#!/bin/bash
# WHY: issue #757 の 10（秘密情報と出口側）のうち「リポジトリと公開ビルドに秘密が混ざらない」を機械検知する。
#   (a) 追跡ファイル**と未追跡ファイル**に秘密らしい文字列が無い（Supabase の JWT / sb_secret_ /
#       sbp_ アクセストークン、秘密鍵、AWS・GitHub・Slack・OpenAI/Anthropic のトークン）。
#       anon key も JWT なので同じ網に掛かる
#       （anon key は公開値だが、コミットせず環境変数で渡す運用を機械化する）
#       WHY(未追跡も見る・2026-09-08 追加): git ls-files は追跡ファイルしか返さないので、
#       書いた直後は必ず緑になる。エージェントは「書く → 検証 → 直す → コミット」の順で動くため、
#       検証の時点で**嘘の緑**を見ていた（E-039。偽の値 2 つを踏み、1 つは履歴に残った）。
#       gitignore 済み（.env.local 等）は引き続き対象外なので、本物の秘密の置き場所は変わらない。
#   (b) SUPABASE_SERVICE_ROLE_KEY はサーバー側だけが参照する。'use client' のファイル・src/components・
#       NEXT_PUBLIC_ 接頭辞での参照は、公開バンドルに service role が入る経路なので拒否する
#   (c) .env / .env.local / .env.test は gitignore されている（.env.test.example だけ追跡）
#   (d) fixture 差し替えで (a)(b) を検知できる（RED 方向の自己検証）
#
# 見つけられないもの: 暗号化・難読化された値、パターンに無い独自形式のトークン。
# **git 履歴に過去に入った秘密は `scripts/check-secret-leak-history.test.sh` が見る**
# （2026-09-08 に追加。パターンは scripts/lib/secret-patterns.txt で共有する）。
# 鍵のローテーション実測は #757 の 29。
#
# 実行: bash scripts/check-secret-leak.test.sh
# 環境変数（テスト用注入ポイント）:
#   SECRET_SCAN_ROOT   走査するリポジトリ（既定はこのリポジトリ）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SECRET_SCAN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 秘密らしい文字列のパターン（ERE）。正本は scripts/lib/secret-patterns.txt で、
# git 履歴の走査（check-secret-leak-history.test.sh）と**同じ網**を使う。
# 2 か所に書くと「今のファイルでは止まるが履歴には入れられる」穴が開く。
SECRET_PATTERNS=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  SECRET_PATTERNS+=("$line")
done < "$SCRIPT_DIR/lib/secret-patterns.txt"
if [ "${#SECRET_PATTERNS[@]}" -eq 0 ]; then
  echo "  NG: パターンが 1 つも読めていない（走査になっていない）" >&2
  exit 1
fi

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# (a) 追跡＋未追跡（gitignore 済みを除く）の秘密らしい文字列を "path:line:match" で返す。$1=リポジトリ
scan_secrets() {
  local root="$1" p
  (
    cd "$root" || exit 1
    for p in "${SECRET_PATTERNS[@]}"; do
      git ls-files -z --cached --others --exclude-standard -- ':!package-lock.json' \
        | xargs -0 grep -n -o -E -I -- "$p" 2>/dev/null || true
    done
  )
}

# (b) service role key を参照してはいけない場所からの参照を返す。$1=リポジトリ
scan_service_role_refs() {
  local root="$1" f
  (
    cd "$root" || exit 1
    git ls-files -z --cached --others --exclude-standard -- 'src/**' \
      | xargs -0 grep -l -- 'SUPABASE_SERVICE_ROLE_KEY' 2>/dev/null \
      | while IFS= read -r f; do
          case "$f" in
            src/components/*) echo "$f: src/components からの参照" ;;
            *) if grep -q -E "^['\"]use client['\"]" "$f"; then echo "$f: 'use client' のファイルからの参照"; fi ;;
          esac
        done
    git ls-files -z --cached --others --exclude-standard \
      | xargs -0 grep -n -o -E -I -- 'NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE[A-Z_]*' 2>/dev/null || true
  )
}

echo "=== scenario 1: 追跡・未追跡のファイルに秘密らしい文字列が無い ==="
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

echo "=== scenario 5: コミット前（未追跡）でも検知し、gitignore 済みは見ない（E-039） ==="
UT_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" "$UT_DIR"' EXIT
git -C "$UT_DIR" init -q
printf 'ignored-secrets.txt\n' > "$UT_DIR/.gitignore"
# WHY: 偽の値もリテラルで書くと**このファイル自身が走査に引っかかる**（E-039 で 2 回踏んだ）。
#      組み立てて作る。
AWS_PREFIX='AK'"IA"
FAKE_AWS="${AWS_PREFIX}$(printf 'Z%.0s' $(seq 1 16))"
printf 'key=%s\n' "$FAKE_AWS" > "$UT_DIR/never-added.txt"
printf 'key=%s\n' "$FAKE_AWS" > "$UT_DIR/ignored-secrets.txt"
UT_HITS="$(scan_secrets "$UT_DIR")"
if printf '%s\n' "$UT_HITS" | grep -q 'never-added.txt'; then
  assert_ok "git add していないファイルでも検知する"
else
  assert_fail "未追跡ファイルを検知できない（書いた直後の緑が当てにならない状態）" "$UT_HITS"
fi
if printf '%s\n' "$UT_HITS" | grep -q 'ignored-secrets.txt'; then
  assert_fail "gitignore 済みのファイルを走査している（.env.local が落ちる）" "$UT_HITS"
else
  assert_ok "gitignore 済みは走査しない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
