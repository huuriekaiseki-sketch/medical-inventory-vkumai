#!/usr/bin/env bash
# WHY(2026-09-11): 入口（route）が catch したエラーの message を**そのまま応答に入れる**箇所が、
#   「翻訳済みだと分かっている型」に絞られているかを見る。走査の本体は
#   scripts/lib/scan-raw-error-response.mjs（型の名前と走査先は aidd.config.json の errorResponse）。
#
#   きっかけは 2026-09-11。中心リポジトリの 3 箇所が `instanceof Error` で受けて message を
#   返していた。手で数えたときは 23 箇所に見え、実際に返しているのは 3 箇所だった——そして
#   **この走査を入れたら、手では見落としていた 4 箇所目**が出た
#   （`const message = err instanceof Error ? err.message : '...'` と**変数へ移してから**返す形）。
#   人が数えると、書き方が 1 つ変わるだけで見落とす。
#
#   同じ日に別の導入先を見ると、`service_role` だけを弾く**ブラックリスト**の形があった。
#   列挙から漏れたものは全部そのまま出るので、この走査は**ホワイトリスト**（型で通す）を前提にする。
#
# 実行: bash scripts/check-raw-error-response.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCANNER="${SCRIPT_DIR}/lib/scan-raw-error-response.mjs"

fail=0
ok()   { echo "  OK: $1"; }
ng()   { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "${TMP_ROOT}"; }
trap cleanup EXIT

# 走査を実行して出力を返す（終了コードは呼び出し側が $? で見る）
run_scan() {
  node "${SCANNER}" "$1" 2>&1
}

# fixture のリポジトリを 1 つ作る
# $1 = 置き場, $2 = route の中身, $3 = 設定を置くか（yes/no）
make_fixture() {
  local root="$1" body="$2" with_config="${3:-yes}"
  mkdir -p "${root}/src/app/api/thing"
  printf '%s\n' "${body}" > "${root}/src/app/api/thing/route.ts"
  if [ "${with_config}" = "yes" ]; then
    cat > "${root}/aidd.config.json" <<'CONFIG'
{
  "errorResponse": {
    "translatedErrorTypes": ["ClientVisibleError"],
    "scanDirs": ["src/app/api"]
  }
}
CONFIG
  fi
}

echo "=== scenario 1: 実物の route に違反が無い ==="
out="$(run_scan "${REPO_ROOT}")"
status=$?
if [ "${status}" -eq 0 ]; then
  ok "違反なし（${out}）"
else
  ng "実物に違反がある" "${out}"
fi
# fail-open 防止: 対象を 1 つも見ていなければ「違反 0」に意味が無い
examined="$(printf '%s' "${out}" | sed -n 's/.*examined=\([0-9]*\).*/\1/p' | tail -1)"
if [ -n "${examined}" ] && [ "${examined}" -ge 5 ]; then
  ok "対象を実際に見ている（examined=${examined}）"
else
  ng "対象がほとんど無い（走査が壊れている疑い）" "${out}"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="

# 2a: そのまま返す
make_fixture "${TMP_ROOT}/a" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof Error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }
}'
out="$(run_scan "${TMP_ROOT}/a")"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "raw-error"; then
  ok "検知: そのまま返している"
else
  ng "そのまま返す形を見逃した" "${out}"
fi

# 2b: 変数へ移してから返す（手で数えると見落とす形）
make_fixture "${TMP_ROOT}/b" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明"
    return Response.json({ error: message }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/b")"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "raw-error"; then
  ok "検知: 変数へ移してから返している"
else
  ng "変数へ移す形を見逃した" "${out}"
fi

# 2c: ブラックリスト（危ない語だけ弾いて、残りは返す）
make_fixture "${TMP_ROOT}/c" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "失敗しました"
    const safe = message.includes("service_role") ? "失敗しました" : message
    return Response.json({ error: safe }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/c")"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "raw-error"; then
  ok "検知: 危ない語だけ弾くブラックリスト"
else
  ng "ブラックリストの形を見逃した" "${out}"
fi

# 2d: catch の外へ切り出したヘルパー（走査の範囲そのものの穴）
#     WHY: この形は最初の版では**見えていなかった**。別の導入先へ当てて「違反 0 件」と出たので
#          気づいた。守れていたのではなく、走査が catch の中しか見ていなかった。
make_fixture "${TMP_ROOT}/i" 'function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "失敗しました"
  if (message.includes("service_role")) {
    return "失敗しました"
  }
  return message
}

export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ error: safeErrorMessage(error) }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/i")"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "raw-error"; then
  ok "検知: catch の外へ切り出したヘルパー"
else
  ng "catch の外に置かれると見えない（走査の範囲が狭い）" "${out}"
fi

echo "=== scenario 3: 正しい形は 1 件も出さない（誤検知しない） ==="

# 3a: 翻訳済みの型で絞っている
make_fixture "${TMP_ROOT}/d" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof ClientVisibleError) {
      return Response.json({ error: error.message }, { status: 409 })
    }
    return Response.json({ error: "失敗しました" }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/d")"
if [ $? -eq 0 ]; then
  ok "誤検知なし: 型で絞っている"
else
  ng "型で絞っているのに違反にした" "${out}"
fi

# 3b: 定数との厳密一致で絞っている
make_fixture "${TMP_ROOT}/e" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === NOT_FOUND) {
      return Response.json({ error: error.message }, { status: 404 })
    }
    return Response.json({ error: "失敗しました" }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/e")"
if [ $? -eq 0 ]; then
  ok "誤検知なし: 定数との厳密一致"
else
  ng "厳密一致なのに違反にした" "${out}"
fi

# 3c: 判定にしか使っていない（返すのは固定文言）
make_fixture "${TMP_ROOT}/f" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("permission denied")) {
      return Response.json({ error: "権限がありません" }, { status: 403 })
    }
    return Response.json({ error: "失敗しました" }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/f")"
if [ $? -eq 0 ]; then
  ok "誤検知なし: 判定にしか使っていない"
else
  ng "判定だけなのに違反にした" "${out}"
fi

# 3d: コメントに書いてあるだけ（直した理由を書けなくならないこと）
make_fixture "${TMP_ROOT}/g" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    // ここは以前 error.message をそのまま返していた
    return Response.json({ error: "失敗しました" }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/g")"
if [ $? -eq 0 ]; then
  ok "誤検知なし: コメントに書いてあるだけ"
else
  ng "コメントを違反にした（直した理由を書けなくなる）" "${out}"
fi

# 3e: 逃がし口（理由つき）
make_fixture "${TMP_ROOT}/h" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    // raw-error-ok: 開発用の診断エンドポイントで、本番では無効
    return Response.json({ error: (error as Error).message }, { status: 500 })
  }
}'
out="$(run_scan "${TMP_ROOT}/h")"
if [ $? -eq 0 ]; then
  ok "誤検知なし: 理由つきの逃がし口"
else
  ng "理由を書いても外れない" "${out}"
fi

echo "=== scenario 4: 走査が空振りしたら落ちる（fail-open 防止） ==="
mkdir -p "${TMP_ROOT}/empty/src/app/api"
cat > "${TMP_ROOT}/empty/aidd.config.json" <<'CONFIG'
{
  "errorResponse": {
    "translatedErrorTypes": ["ClientVisibleError"],
    "scanDirs": ["src/app/api"]
  }
}
CONFIG
out="$(run_scan "${TMP_ROOT}/empty")"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "見つけられなかった"; then
  ok "route が 0 件なら落ちる"
else
  ng "route が 0 件でも通ってしまう" "${out}"
fi

echo "=== scenario 5: 設定が無い導入先では黙って通る ==="
make_fixture "${TMP_ROOT}/noconf" 'export async function GET() {
  try {
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 })
  }
}' no
out="$(run_scan "${TMP_ROOT}/noconf")"
if [ $? -eq 0 ] && printf '%s' "${out}" | grep -q "configured=false"; then
  ok "設定が無ければ何も見ない（導入先が決める）"
else
  ng "設定が無いのに何か言っている" "${out}"
fi

if [ "${fail}" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
