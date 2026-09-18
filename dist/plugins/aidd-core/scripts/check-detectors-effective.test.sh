#!/usr/bin/env bash
# WHY(C-022、2026-09-09): 「壊して落ちることを確かめずに、緑だけを見て終える」の機械化。
#
#      検査を書いたあと、**それが効いているか**は緑からは分からない。
#      判定が空振りしていても出力は同じ「ALL PASSED」になる。
#      唯一の測り方は壊してみること: 判定を 1 か所だけ壊し、対応する検査が**落ちるか**を見る。
#
#      このファイル自身がその一番の当事者なので、**自分も壊されて測られる**形にしてある:
#      本物の登録簿で実測する（scenario 1）だけでなく、
#      「生き残りを見逃さないか」「壊し方が陳腐化していないか」を fixture で固定する。
#
#   1. **実物**: 宣言した壊し方 16 件がすべて撃破される（＝それらの検査は本当に効いている）
#   2. 生き残り（壊しても落ちないテスト）を見逃さない
#   3. 壊し方が当たらない（0 か所）を陳腐化として落とす
#   4. 壊し方が 2 か所に当たるのも落とす（どこを壊したか言えない）
#   5. 壊す前から赤いテストを「撃破」と読まない（C-021）
#   6. 下限（minMutants）を割ったら落ちる（ratchet）
#   7. 走ったあと、壊した相手が**バイト列で元どおり**になっている
#   8. 壊す相手・落ちるはずのテストが実在しなければ落ちる
#   9. 登録簿が無い導入先では対象 0 件で通る（エンジンは配る・壊し方は導入先が決める）
#
# 実行: bash scripts/check-detectors-effective.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENGINE="$SCRIPT_DIR/lib/check-detectors-effective.mjs"

# WHY(2026-09-12): 実態を見る場面は「対象なし」と言えるのに、**RED 方向の自己検証**
#      （fixture を作ってエンジンを呼び、検知できることを確かめる部分）が node 不在で落ち、
#      検査全体が赤くなっていた。「この導入先に違反があるか」ではなく「この検査が壊れて
#      いないか」を確かめられないだけなので、合格にも違反にも数えさせない（E-090）。
command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので壊し方を測れない。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected to find: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  NG: $label"; echo "      unexpected: $needle"; echo "      actual: $haystack"; fail=1
  else echo "  OK: $label"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- fixture: 小さな「判定エンジン」と、それを見るテスト・見ないテスト -------------------
FX="$WORK/fx"
mkdir -p "$FX"
cat > "$FX/engine.mjs" <<'JS'
export const ANSWER = 1
export const OTHER = 2
JS

# 判定を見るテスト（壊せば落ちる）
cat > "$FX/strict.test.sh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --input-type=module -e "
  const m = await import('file://$DIR/engine.mjs')
  if (m.ANSWER !== 1) { console.log('NG'); process.exit(1) }
  console.log('ALL PASSED')
"
SH

# 判定を見ないテスト（壊しても落ちない ＝ 何も守っていない）
cat > "$FX/loose.test.sh" <<'SH'
#!/usr/bin/env bash
echo "ALL PASSED"
exit 0
SH

# 壊す前から落ちているテスト
cat > "$FX/red.test.sh" <<'SH'
#!/usr/bin/env bash
echo "FAILED"
exit 1
SH

cp "$FX/engine.mjs" "$WORK/engine.mjs.orig"

# $1=登録簿の中身（JSON）。結果を $OUT に、終了コードを $LAST_CODE に置く。
# WHY(戻り値を変数で渡す): `$( )` は副シェルなので、その中で代入した終了コードは親に返らない。
#      **終了コードこそがこの検査の答え**（生き残りがあれば 0 でない）なので、取りこぼさない形にする
run_engine() {
  printf '%s' "$1" > "$FX/registry.json"
  node "$ENGINE" --root "$FX" --registry "$FX/registry.json" --quiet > "$WORK/out.txt" 2>&1
  LAST_CODE=$?
  OUT="$(cat "$WORK/out.txt")"
}

mutant() { # $1=id $2=expect $3=find $4=replace
  printf '{"id":"%s","breaks":"fixture","file":"engine.mjs","expect":"%s","find":"%s","replace":"%s"}' \
    "$1" "$2" "$3" "$4"
}

echo "=== scenario 1: 実物の登録簿で、宣言した壊し方がすべて撃破される ==="
# WHY(登録簿が無ければ飛ばす): エンジンは配るが壊し方は導入先が決める。
#      まだ決めていない導入先でここが落ちると、**入れた瞬間に赤い**検査になってしまう
if [ -f "$REPO_ROOT/scripts/lib/check-mutants.json" ]; then
  OUT="$(cd "$REPO_ROOT" && node "$ENGINE" --quiet 2>&1)"
  CODE=$?
  assert_contains "$OUT" "判定を壊すと確かに落ちました" "宣言した壊し方がすべて効いている"
  assert_not_contains "$OUT" "生き残り" "生き残りが 1 件も無い"
  if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi
else
  # WHY(2026-09-12): 印の語を「対象なし」に揃える。呼ぶ側（aidd-check）は
  #      この語で「見た結果の合格」と「対象が無いので黙った」を分ける（C-025）。
  echo "  SKIP: 対象なし（登録簿が無い導入先。壊し方をまだ決めていない）"
fi

echo "=== scenario 2: 生き残り（壊しても落ちないテスト）を見逃さない ==="
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-LOOSE loose.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
assert_contains "$OUT" "FX-LOOSE [生き残り]" "壊しても通るテストを名指しする"
assert_contains "$OUT" "1 件が撃破できていません" "件数を数えている"
if [ "$LAST_CODE" -ne 0 ]; then echo "  OK: exit 0 でない"; else echo "  NG: 生き残りがあるのに exit 0"; fail=1; fi

echo "=== scenario 3: 判定を見ているテストは撃破される（対照） ==="
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-STRICT strict.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
assert_contains "$OUT" "FX-STRICT [撃破]" "壊すと落ちるテストは撃破"
if [ "$LAST_CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $LAST_CODE"; fail=1; fi

echo "=== scenario 4: 壊し方が陳腐化している（0 か所 / 2 か所） ==="
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-GONE strict.test.sh 'ANSWER = 42' 'ANSWER = 9')]}"
assert_contains "$OUT" "FX-GONE [壊し方が陳腐化]" "当たらない壊し方を落とす"
assert_contains "$OUT" "0 か所" "何が起きたかを言う"
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-AMBIG strict.test.sh 'export const' 'const')]}"
assert_contains "$OUT" "FX-AMBIG [壊し方が陳腐化]" "2 か所に当たる壊し方も落とす"
assert_contains "$OUT" "どこを壊したか言えません" "どこを壊したか言えないと伝える"

echo "=== scenario 5: 壊す前から赤いテストを「撃破」と読まない（C-021） ==="
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-RED red.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
assert_contains "$OUT" "FX-RED [壊す前から赤い]" "素で赤いことを先に言う"
assert_not_contains "$OUT" "FX-RED [撃破]" "赤いまま落ちたのを撃破と読まない"
if [ "$LAST_CODE" -ne 0 ]; then echo "  OK: exit 0 でない"; else echo "  NG: 比較になっていないのに exit 0"; fail=1; fi

echo "=== scenario 6: 下限（minMutants）を割ったら落ちる（ratchet） ==="
run_engine "{\"minMutants\":5,\"mutants\":[$(mutant FX-STRICT strict.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
assert_contains "$OUT" "壊し方が 1 件しかありません" "下限を割ったら落とす"
run_engine "{\"mutants\":[$(mutant FX-STRICT strict.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
assert_contains "$OUT" "minMutants（下限）がありません" "下限の書き忘れも落とす"
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-SAME strict.test.sh 'ANSWER = 1' 'ANSWER = 1')]}"
assert_contains "$OUT" "find と replace が同じです" "何も壊していない宣言を落とす"

echo "=== scenario 7: 走ったあと、壊した相手がバイト列で元どおり ==="
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-LOOSE loose.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
if cmp -s "$FX/engine.mjs" "$WORK/engine.mjs.orig"; then
  echo "  OK: 生き残っても元に戻す"
else
  echo "  NG: 壊したまま残っている"; fail=1
fi
run_engine "{\"minMutants\":1,\"mutants\":[$(mutant FX-STRICT strict.test.sh 'ANSWER = 1' 'ANSWER = 9')]}"
if cmp -s "$FX/engine.mjs" "$WORK/engine.mjs.orig"; then
  echo "  OK: 撃破しても元に戻す"
else
  echo "  NG: 壊したまま残っている"; fail=1
fi

echo "=== scenario 8: 壊す相手・落ちるはずのテストが実在しない ==="
run_engine "{\"minMutants\":1,\"mutants\":[{\"id\":\"FX-NOFILE\",\"breaks\":\"fixture\",\"file\":\"nope.mjs\",\"expect\":\"strict.test.sh\",\"find\":\"x\",\"replace\":\"y\"}]}"
assert_contains "$OUT" "壊す相手 nope.mjs がありません" "壊す相手の不在を検知"
run_engine "{\"minMutants\":1,\"mutants\":[{\"id\":\"FX-NOTEST\",\"breaks\":\"fixture\",\"file\":\"engine.mjs\",\"expect\":\"nope.test.sh\",\"find\":\"x\",\"replace\":\"y\"}]}"
assert_contains "$OUT" "落ちるはずのテスト nope.test.sh がありません" "測る相手の不在を検知"

echo "=== scenario 9: 登録簿が無い導入先は対象 0 件で通る ==="
rm -f "$FX/registry.json"
node "$ENGINE" --root "$FX" --registry "$FX/registry.json" --quiet > "$WORK/out.txt" 2>&1
LAST_CODE=$?
OUT="$(cat "$WORK/out.txt")"
assert_contains "$OUT" "登録簿が無いので対象 0 件" "登録簿の無い導入先は黙って通る"
if [ "$LAST_CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $LAST_CODE"; fail=1; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
