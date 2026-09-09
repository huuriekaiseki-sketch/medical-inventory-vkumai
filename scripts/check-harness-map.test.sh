#!/usr/bin/env bash
# WHY(2026-09-10): ハーネスの地図（docs/agents/harness-map.md）を手で書いていたら、
#      **同じ日に台帳の数字を 2 回取り違えた**（別の台帳の数を足した／数える単位を取り違えた）。
#      表を生成物にし、数字は台帳の実物から読むようにしたので、その仕組みの回帰テスト。
#
#      この検査が空振りすると「地図は最新」で緑になる（いちばん危ない外れ方）ので、次を固定する:
#
#   1. 実物の登録簿に違反が無く、生成物が最新である
#   2. 起動・状態の語彙から外れたら落ちる（`人` を `たぶん人` と書けない）
#   3. 宣言した入口・検査・限界の文書が**実在しない**と落ちる（地図に書いてあるのに無い、を止める）
#   4. 台帳が読めない・数字でないと落ちる
#   5. 検査を 1 つも持たないハーネスは落ちる（「あると言っているだけ」を止める）
#   6. 登録簿を読めていないとき（0 件）は落ちる（fail-open 防止）
#   7. 生成物が古いと `--check` が落ちる（**最新なら通る**の対照つき）
#   8. 登録簿が無い導入先は対象 0 件で通る（エンジンだけ配られた先で赤くしない）
#   9. **逆向きの ratchet**——実在する検査が全部どこかのハーネスに属している。
#      同じ検査を 2 か所に置けない。検査を 1 本も見つけられなければ落ちる（走査の空振り防止）
#
# 実行: bash scripts/check-harness-map.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RENDER="$SCRIPT_DIR/render-harness-map.sh"
ENGINE="$SCRIPT_DIR/lib/render-harness-map.mjs"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected: $2"; echo "      actual:   $1"; fail=1; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "  OK: $3"; else
    echo "  NG: $3"; echo "      expected to find: $2"; echo "      actual: $1"; fail=1; fi
}

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# fixture の土台。`--root` に渡す小さなリポジトリを作る
mkdir -p "$WORK/root/scripts/lib" "$WORK/root/docs"
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/entry.sh"
printf '# doc\n' > "$WORK/root/docs/limits.md"
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/check-thing.test.sh"
printf '{"pending": [1, 2, 3]}' > "$WORK/root/scripts/lib/ledger.json"

write_registry() { # $1 = ハーネス 1 件の JSON
  cat > "$WORK/registry.json" <<JSON
{
  "generatedMarker": "m",
  "output": "docs/map.md",
  "triggers": { "機械": "a", "人": "b", "外部待ち": "c" },
  "harnesses": [ $1 ]
}
JSON
}
GOOD='{
  "id": "H-01", "role": "テスト", "guards": "何かを守る",
  "trigger": "機械", "triggerDetail": "毎回",
  "entrypoints": ["scripts/entry.sh", "run-the-suite"],
  "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [{ "name": "借金", "unit": "件", "file": "scripts/lib/ledger.json", "path": "pending.length" }],
  "limitsDoc": "docs/limits.md", "state": "あり"
}'

write_doc() {
  printf '# 地図\n\n<!-- generated:m start -->\n<!-- generated:m end -->\n\nおわり\n' > "$WORK/root/docs/map.md"
}

run_engine() { # $@ = engine の引数。出力と終了コードをグローバルに置く
  # WHY(副シェルを作らない): `OUT="$(run_engine ...)"` と書くと終了コードが親に返らず、
  #      **落ちる側を測れなくなる**（2026-09-09・2026-09-10 に 2 回踏んだ）
  ENGINE_OUT="$(node "$ENGINE" "$WORK/registry.json" --root "$WORK/root" "$@" 2>&1)"
  ENGINE_CODE=$?
}

echo "=== scenario 1: 実物の登録簿に違反が無く、生成物が最新 ==="
OUT="$(bash "$RENDER" --check 2>&1)"
CODE=$?
assert_eq "$CODE" "0" "実物が最新（違反 0 件）"
assert_contains "$OUT" "最新" "最新だと言う"

echo "=== scenario 7: 生成物が古いと落ちる（最新なら通る、の対照つき） ==="
write_registry "$GOOD"
write_doc
run_engine
assert_eq "$ENGINE_CODE" "0" "書き出しは通る"
run_engine --check
assert_eq "$ENGINE_CODE" "0" "書き出した直後は最新（対照）"
# 台帳の数字だけを変える → 生成物が古くなる
printf '{"pending": [1, 2]}' > "$WORK/root/scripts/lib/ledger.json"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "台帳の数字が変わったら古いと言う"
assert_contains "$ENGINE_OUT" "作り直す" "作り直し方を案内する"
printf '{"pending": [1, 2, 3]}' > "$WORK/root/scripts/lib/ledger.json"

echo "=== scenario 2: 起動・状態の語彙から外れたら落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's/"trigger": "機械"/"trigger": "たぶん人"/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "知らない起動の語で落ちる"
assert_contains "$ENGINE_OUT" "unknown-trigger" "起動の語を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's/"state": "あり"/"state": "だいたい"/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "知らない状態の語で落ちる"
assert_contains "$ENGINE_OUT" "unknown-state" "状態の語を名指しする"

echo "=== scenario 3: 宣言したものが実在しないと落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/entry.sh#scripts/nope.sh#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "入口が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-entrypoint" "無い入口を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/check-thing.test.sh#scripts/check-nope.test.sh#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "検査が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-check" "無い検査を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#docs/limits.md#docs/nope.md#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "限界の文書が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-limits-doc" "無い文書を名指しする"

echo "=== scenario 4: 台帳が読めない・数字でないと落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#scripts/lib/ledger.json#scripts/lib/nope.json#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "台帳が無いと落ちる"
assert_contains "$ENGINE_OUT" "missing-ledger" "無い台帳を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#"path": "pending.length"#"path": "pending"#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "数字にならない道で落ちる"
assert_contains "$ENGINE_OUT" "ledger-not-a-number" "数字でないことを名指しする"

echo "=== scenario 5: 検査を 1 つも持たないハーネスは落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's#"checks": \["scripts/check-thing.test.sh"\]#"checks": []#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "検査 0 件で落ちる"
assert_contains "$ENGINE_OUT" "no-checks" "「測る検査が無い」と名指しする"

echo "=== scenario 10: 実在する検査が全部どこかのハーネスに属している（逆向きの ratchet） ==="
# WHY(2026-09-10): 宣言した検査が実在するか（scenario 3）は見ていたが、**逆向き**——
#      実在する検査が全部どこかに属するか——を見ていなかった。
#      それだと「新しい検査を足したのに地図に載らない」＝役割の分からない検査が静かに増える。
write_registry "$GOOD"
write_doc
run_engine   # 先に書き出す（--check は生成物の鮮度も見るので、印だけの文書だと古い扱いになる）
# 土台には check-thing.test.sh しか無く、それは GOOD が宣言している → 通る（対照）
run_engine --check
assert_eq "$ENGINE_CODE" "0" "全部が属していれば通る（対照）"

# 属していない検査を 1 本置く → 落ちる
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/check-orphan.test.sh"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "どこにも属さない検査があれば落ちる"
assert_contains "$ENGINE_OUT" "unassigned-check" "属していない検査を名指しする"
assert_contains "$ENGINE_OUT" "check-orphan.test.sh" "ファイル名を出す"
rm -f "$WORK/root/scripts/check-orphan.test.sh"

# scripts/lib/ 側も対象（hooks-test が回すのと同じ集合）
mkdir -p "$WORK/root/scripts/lib"
printf '#!/usr/bin/env bash\n' > "$WORK/root/scripts/lib/check-lib-orphan.test.sh"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "scripts/lib/ の検査も数える"
assert_contains "$ENGINE_OUT" "scripts/lib/check-lib-orphan.test.sh" "lib 側も名指しする"
rm -f "$WORK/root/scripts/lib/check-lib-orphan.test.sh"

echo "=== scenario 11: 同じ検査を 2 つのハーネスに置けない ==="
# WHY: 2 か所に置けると「どの役割が守っているのか」が決まらない。数え上げも二重になる
TWO='{
  "id": "H-01", "role": "あ", "guards": "a", "trigger": "機械", "triggerDetail": "b",
  "entrypoints": ["scripts/entry.sh"], "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [], "limitsDoc": "docs/limits.md", "state": "あり"
},
{
  "id": "H-02", "role": "い", "guards": "a", "trigger": "機械", "triggerDetail": "b",
  "entrypoints": ["scripts/entry.sh"], "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [], "limitsDoc": "docs/limits.md", "state": "あり"
}'
write_registry "$TWO"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "同じ検査が 2 か所にあれば落ちる"
assert_contains "$ENGINE_OUT" "duplicate-check" "二重の割り当てを名指しする"

echo "=== scenario 12: 検査を 1 本も見つけられなければ落ちる（走査の空振り防止） ==="
# WHY: 走査が壊れると「違反 0 件」で通ってしまう。**0 本は健全ではなく異常**（C-021）
write_registry "$GOOD"
mv "$WORK/root/scripts/check-thing.test.sh" "$WORK/root/scripts/check-thing.hidden"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "検査が 0 本なら落ちる"
assert_contains "$ENGINE_OUT" "no-check-scripts" "走査が壊れている疑いだと言う"
mv "$WORK/root/scripts/check-thing.hidden" "$WORK/root/scripts/check-thing.test.sh"

echo "=== scenario 6: 登録簿を読めていないとき（0 件）は落ちる ==="
printf '{"generatedMarker":"m","output":"docs/map.md","triggers":{},"harnesses":[]}' > "$WORK/registry.json"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "0 件なら落ちる（fail-open 防止）"
assert_contains "$ENGINE_OUT" "1 件も無い" "読めていない疑いだと言う"

echo "=== scenario 8: 印が無い文書で落ちる ==="
write_registry "$GOOD"
printf '# 地図\n\n印が無い\n' > "$WORK/root/docs/map.md"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "印が無ければ落ちる"
assert_contains "$ENGINE_OUT" "印" "印が無いことを言う"

echo "=== scenario 9: 登録簿が無い導入先は対象 0 件で通る ==="
OUT="$(HARNESS_REGISTRY="$WORK/does-not-exist.json" bash "$RENDER" --check 2>&1)"
CODE=$?
assert_eq "$CODE" "0" "登録簿が無ければ黙って通る"
assert_contains "$OUT" "対象 0 件" "対象が無いと言う"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
