#!/bin/bash
# WHY(2026-09-13): issue #757 の C 節「Archive slip・symlink・Git hook・submodule・巨大入力」。
#      この製品には 2026-09-12 時点でファイル・アーカイブを受け取る経路が 1 つも無いので、
#      展開時のパス traversal（archive slip）・symlink・Git hook/submodule・圧縮爆弾の検査は
#      書きようがない。検査を「いつか書く」で終わらせないため、
#      **受け取り経路が生えた瞬間に落ちる ratchet** にする（手本は check-export-paths.test.sh）。
#
#      2026-09-12 の実測。4 経路すべて 0 件で、測った印は
#      docs/agents/security-test-catalog.md の「前提を実測で確かめた行」に残してある:
#        - UI:        <input type="file"> が 0 件
#        - サーバー:  request.formData() が 0 件
#        - Storage:   Supabase Storage（storage.from / getPublicUrl）が 0 件
#        - 依存:      multer・busboy・formidable・tar・unzipper 等 12 個すべて未導入
#
#      **印を FormData にしてはいけない**。既存の 6 ファイルは `new FormData(e.currentTarget)` で
#      フォームの値を読んでいるだけで、ファイル受け取りではない（2026-09-12 実測）。
#      6 件を「該当あり」と読むのが、この検査でいちばんやりやすい間違い。
#      だから印はサーバー側のメソッド呼び出し `.formData()` に絞り、
#      scenario 5 の clean fixture に**実物と同じ書き方**を入れて誤検知しないことを毎回確かめる。
#
#   (a) src/ にファイル受け取りの実装が無い
#   (b) package.json にファイル・アーカイブ系の依存が無い
#   (c) 許可リスト（ALLOWLIST）に載せた実装済み経路だけは (a)(b) を免除する
#   (d) 引き出し（security-test-catalog）の該当行がこの ratchet を指している
#   (e) fixture で (a)(b) を検知でき、実物と同じ書き方を誤検知しない（RED 方向の自己検証）
#   (f) **走査が空振りしていない**（C-044）。手本の check-export-paths.test.sh は
#       `[ -d "$root/src" ] || return 0` と書いてあり、src/ が消えた日に**黙って緑になる**。
#       同じ形にせず、走査対象が無いことは「確認不能」として落とす。
#
# 限界:
#   - 印は「よくある書き方」であって網羅ではない。生の Web Streams で multipart を自前解析する、
#     署名付き URL をクライアントへ渡してストレージへ直接 PUT させる、といった形は捕まらない
#   - 走査は src/ と package.json だけを見る。supabase/functions/ 等を足したらここにも足す
#   - 「受け取っているか」までで、**受け取ったあと安全に扱えているか**は見ない（それは落ちた後に書く検査）
#
# 実行: bash scripts/check-file-intake-paths.test.sh
# 環境変数（テスト用注入ポイント）: FILE_INTAKE_SCAN_ROOT
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN_ROOT="${FILE_INTAKE_SCAN_ROOT:-$REPO_ROOT}"

# ファイル受け取りを実装したらここにパスを足し、同時に下のチェックリストを満たすこと。
# 空 = 現在ファイル・アーカイブの受け取り経路は無い。
ALLOWLIST=""

INTAKE_CHECKLIST='このテストが落ちたら、ファイル・アーカイブ・外部 Git の受け取り経路を足したということ。
      次を満たしてから ALLOWLIST に追記する:
      1. archive slip: 展開先を実パスに解決し、保存先ディレクトリの外へ出るエントリ（.. と絶対パス）を捨てる。
         守るテストに「../../etc/passwd を含む書庫」の実ケースを置く
      2. symlink: 展開で symlink を作らない・辿らない。書庫内の symlink エントリは捨てる
      3. Git hook / submodule: 外部 Git を clone するなら core.hooksPath を無効化し、
         submodule を自動で辿らない（--no-recurse-submodules）
      4. 圧縮爆弾: 展開後の合計サイズ・エントリ数・深さに上限を置き、超えたら途中で止める。
         上限値は aidd.config.json の limits へ出し、docs/agents/design-questions.md に行を足す
      5. 保存先の施設スコープ: 受け取ったファイルが他施設から読めないことを実 DB の統合テストで固定する
         （RLS を通す経路で作り、service role で作らない）。P-017 の攻撃表にも route を足す
      6. docs/agents/security-test-catalog.md「Archive slip・symlink・Git hook・submodule・巨大入力」を
         実装済み にし、守るテストのパスを書く'

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# (a) 実装の走査。$1=走査ルート
# WHY: FormData ではなく .formData() を見る（ヘッダの説明を参照）
scan_source() {
  local root="$1"
  [ -d "$root/src" ] || return 0
  grep -rn \
    -e 'type="file"' \
    -e "type='file'" \
    -e '\.formData()' \
    -e 'storage\.from(' \
    -e 'getPublicUrl(' \
    "$root/src" 2>/dev/null || true
}

# (b) 依存の走査。$1=走査ルート
scan_deps() {
  local root="$1"
  [ -f "$root/package.json" ] || return 0
  grep -n \
    -e '"multer"' -e '"busboy"' -e '"formidable"' \
    -e '"tar"' -e '"unzipper"' -e '"adm-zip"' -e '"jszip"' \
    -e '"archiver"' -e '"extract-zip"' -e '"node-stream-zip"' \
    -e '"simple-git"' -e '"@aws-sdk/client-s3"' \
    "$root/package.json" 2>/dev/null || true
}

# (f) 走査したファイル数。0 なら空振り
count_scanned() {
  local root="$1"
  [ -d "$root/src" ] || { echo 0; return; }
  find "$root/src" -type f 2>/dev/null | wc -l | tr -d ' '
}

# 許可リストに載っているパスの行を除く
drop_allowlisted() {
  local hits="$1" p
  [ -n "$ALLOWLIST" ] || { printf '%s' "$hits"; return; }
  for p in $ALLOWLIST; do
    hits="$(grep -v -F "$p" <<<"$hits" || true)"
  done
  printf '%s' "$hits"
}

echo "=== scenario 1: src/ にファイル受け取りの実装が無い ==="
HITS="$(drop_allowlisted "$(scan_source "$SCAN_ROOT")")"
if [ -z "$HITS" ]; then
  assert_ok "ファイル受け取りの実装なし（許可リスト: ${ALLOWLIST:-なし}）"
else
  assert_fail "ファイル受け取りの経路が増えている" "${HITS}
      ${INTAKE_CHECKLIST}"
fi

echo "=== scenario 2: ファイル・アーカイブ系の依存が無い ==="
DEPS="$(scan_deps "$SCAN_ROOT")"
if [ -z "$DEPS" ]; then
  assert_ok "ファイル・アーカイブ系ライブラリなし"
else
  assert_fail "ファイル・アーカイブ系ライブラリが入っている" "${DEPS}
      ${INTAKE_CHECKLIST}"
fi

echo "=== scenario 3: 引き出しの行がこの ratchet を指している ==="
CATALOG="$REPO_ROOT/docs/agents/security-test-catalog.md"
ROW="$(grep '^| Archive slip' "$CATALOG" || true)"
if [ -z "$ROW" ]; then
  assert_fail "security-test-catalog に「Archive slip」の行が無い"
elif grep -q 'check-file-intake-paths.test.sh' <<<"$ROW"; then
  assert_ok "引き出しの行がこの ratchet を指している"
else
  assert_fail "引き出しの行がこの ratchet を指していない（状態と引き金を書き換える）" "$ROW"
fi

echo "=== scenario 4: 走査が空振りしていない（確認不能を緑にしない） ==="
# WHY: 手本は src/ が無いと黙って return 0 する。無いことを「無害」と読ませない（C-044）
if [ ! -d "$SCAN_ROOT/src" ]; then
  assert_fail "走査対象 src/ が無い。ファイル受け取りが無いのか走査先を間違えたのか区別できない（確認不能）"
elif [ ! -f "$SCAN_ROOT/package.json" ]; then
  assert_fail "走査対象 package.json が無い（確認不能）"
else
  SCANNED="$(count_scanned "$SCAN_ROOT")"
  if [ "$SCANNED" -ge 1 ]; then
    assert_ok "走査したファイル ${SCANNED} 本"
  else
    assert_fail "src/ にファイルが 1 本も無い。走査が空振りしている（確認不能）"
  fi
fi

echo "=== scenario 5: fixture で検知でき、実物と同じ書き方を誤検知しない（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/src/app/api/upload" "$WORK/src/components" "$WORK/src/lib"
cat > "$WORK/src/app/api/upload/route.ts" <<'EOF'
export async function POST(request: Request) {
  const body = await request.formData()
  const file = body.get('file') as File
  return Response.json({ size: file.size })
}
EOF
cat > "$WORK/src/components/UploadForm.tsx" <<'EOF'
export function UploadForm() {
  return <input type="file" name="attachment" />
}
EOF
cat > "$WORK/src/lib/storage.ts" <<'EOF'
export async function put(client: SupabaseClient, path: string, f: File) {
  return client.storage.from('attachments').upload(path, f)
}
EOF
cat > "$WORK/package.json" <<'EOF'
{ "dependencies": { "unzipper": "^0.12.3" } }
EOF

DIRTY_SRC="$(scan_source "$WORK")"
DIRTY_DEPS="$(scan_deps "$WORK")"
if grep -q 'formData()' <<<"$DIRTY_SRC"; then assert_ok "サーバー側の multipart 受け取りを検知"; else assert_fail "multipart の受け取りを検知できない" "$DIRTY_SRC"; fi
if grep -q 'type="file"' <<<"$DIRTY_SRC"; then assert_ok "ファイル選択 UI を検知"; else assert_fail "ファイル選択 UI を検知できない" "$DIRTY_SRC"; fi
if grep -q 'storage.from(' <<<"$DIRTY_SRC"; then assert_ok "Supabase Storage への保存を検知"; else assert_fail "Supabase Storage を検知できない" "$DIRTY_SRC"; fi
if grep -q 'unzipper' <<<"$DIRTY_DEPS"; then assert_ok "アーカイブ系依存を検知"; else assert_fail "アーカイブ系依存を検知できない" "$DIRTY_DEPS"; fi

# WHY: 実物の 6 ファイルと同じ書き方。ここを誤検知すると ratchet は初日から赤く、無効化される
mkdir -p "$WORK/clean/src/components"
cat > "$WORK/clean/src/components/ProductForm.tsx" <<'EOF'
export function ProductForm({ onSubmit }: Props) {
  const handle = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    onSubmit({ name: formData.get('name') as string })
  }
  return <input type="text" name="name" />
}
EOF
printf '{ "dependencies": { "next": "16.3.4", "@supabase/supabase-js": "^2.108.2" } }\n' > "$WORK/clean/package.json"
CLEAN="$(scan_source "$WORK/clean")$(scan_deps "$WORK/clean")"
if [ -z "$CLEAN" ]; then
  assert_ok "実物と同じ new FormData(e.currentTarget) を誤検知しない"
else
  assert_fail "普通のフォームを誤検知した（印が広すぎる）" "$CLEAN"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
