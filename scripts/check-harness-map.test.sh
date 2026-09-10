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
  "limitsDoc": "docs/limits.md",
  "guardIds": [], "guardIdsReason": "この fixture では台帳を持たない",
  "preconditions": "なし",
  "evidence": [{ "name": "全件実行", "log": "logs/thing-runs.jsonl", "watch": ["scripts"] }],
  "falsification": "scripts/check-thing.test.sh"
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

echo "=== scenario 2: 起動の語彙から外れたら落ちる ==="
write_registry "$(printf '%s' "$GOOD" | sed 's/"trigger": "機械"/"trigger": "たぶん人"/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "知らない起動の語で落ちる"
assert_contains "$ENGINE_OUT" "unknown-trigger" "起動の語を名指しする"

echo "=== scenario 13: 契約の欄が空なら落ちる（レビューの設計提案 1） ==="
# WHY(2026-09-10): 状態の欄は手書きの「あり / 一部」だった。登録簿自身が
#      「『あり』は中身の十分性を保証しない」と書いており、**確かめようのない 1 語**が
#      いちばん目立つ場所に載っていた。その 1 語を消し、代わりに
#      **機械で実在を確かめられる宣言**（守る対象・前提・実測の記録・反証）を必須にした。
#      理由を書けば空でよいが、**黙って空にはできない**のが肝。
write_registry "$(printf '%s' "$GOOD" | sed 's/"guardIdsReason": "この fixture では台帳を持たない"/"guardIdsReason": ""/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "守る対象が空で理由も無ければ落ちる"
assert_contains "$ENGINE_OUT" "missing-guard-ids" "守る対象の欠落を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's/"preconditions": "なし"/"preconditions": ""/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "前提が空なら落ちる"
assert_contains "$ENGINE_OUT" "missing-preconditions" "前提の欠落を名指しする"

write_registry "$(printf '%s' "$GOOD" | sed 's#"falsification": "scripts/check-thing.test.sh"#"falsification": ""#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "反証の宣言が無ければ落ちる"
assert_contains "$ENGINE_OUT" "missing-falsification" "反証の欠落を名指しする"

# 実測の記録を持たないのは構わない。ただし**なぜ持たないか**は書かせる
write_registry "$(printf '%s' "$GOOD" | sed 's#"evidence": \[{ "name": "全件実行", "log": "logs/thing-runs.jsonl", "watch": \["scripts"\] }\]#"evidence": []#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "記録が無く理由も無ければ落ちる"
assert_contains "$ENGINE_OUT" "missing-evidence" "記録の欠落を名指しする"

# 見張る木が無いと「最新かどうか」を永久に判定できない（測っただけで終わる）
write_registry "$(printf '%s' "$GOOD" | sed 's#"watch": \["scripts"\]#"watch": []#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "見張る木が無ければ落ちる"
assert_contains "$ENGINE_OUT" "evidence-without-watch" "どの木に対する結果か分からないと言う"

write_registry "$(printf '%s' "$GOOD" | sed 's#"watch": \["scripts"\]#"watch": ["nope"]#')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "見張る木が実在しなければ落ちる"
assert_contains "$ENGINE_OUT" "missing-watch-path" "無い木を名指しする"

echo "=== scenario 14: 守る対象の ID が台帳に実在するかを見る ==="
# WHY: 「何を守るか」が文章だけだと機械で追えない。台帳の ID で宣言させ、実在を突き合わせる。
#      台帳を持たない導入先では確かめようが無いので、**その場合は黙って通す**（誤検知を作らない）
mkdir -p "$WORK/root/scripts/lib" "$WORK/root/docs"
cat > "$WORK/root/scripts/lib/catalog-registry.json" <<'JSON'
{ "catalogs": [ { "id": "x", "file": "docs/x-catalog.md", "idPrefix": "X" } ] }
JSON
printf '| ID | 何か |\n| --- | --- |\n| X-010 | ある |\n' > "$WORK/root/docs/x-catalog.md"

write_registry "$(printf '%s' "$GOOD" | sed 's/"guardIds": \[\]/"guardIds": ["X-010"]/')"
write_doc
run_engine
assert_eq "$ENGINE_CODE" "0" "台帳に実在する ID なら通る（対照）"

write_registry "$(printf '%s' "$GOOD" | sed 's/"guardIds": \[\]/"guardIds": ["X-999"]/')"
run_engine --check
assert_eq "$ENGINE_CODE" "1" "台帳に無い ID なら落ちる"
assert_contains "$ENGINE_OUT" "unknown-guard-id" "無い ID を名指しする"
assert_contains "$ENGINE_OUT" "X-999" "どの ID かを出す"
rm -f "$WORK/root/scripts/lib/catalog-registry.json" "$WORK/root/docs/x-catalog.md"

echo "=== scenario 15: 証拠の状態を実測の記録から出す（レビューの設計提案 4） ==="
# WHY: 測定 / 合格 / 最新 を**潰さずに**別々に出す（C-025）。
#      記録は機械ローカルなので、コミットする文書へは焼き込まない（環境ごとに生成物が割れるため）
write_registry "$GOOD"
write_doc
run_engine
mkdir -p "$WORK/root/logs"

# (a) 記録が 1 行も無い → 測定 ❌
rm -f "$WORK/root/logs/thing-runs.jsonl"
run_engine --evidence
assert_eq "$ENGINE_CODE" "0" "記録が無くても出力そのものは通る"
assert_contains "$ENGINE_OUT" "測定 ❌" "一度も回していないことを出す"
assert_contains "$ENGINE_OUT" "一度も回していない" "理由を出す"

# (b) 直近が赤 → 合格 ❌
SCRIPTS_TREE="$(cd "$WORK/root" && git rev-parse "HEAD:scripts" 2>/dev/null || echo unknown)"
printf '{"at":"2026-01-01T00:00:00Z","result":"fail","scriptsTree":"%s"}\n' "$SCRIPTS_TREE" > "$WORK/root/logs/thing-runs.jsonl"
run_engine --evidence
assert_contains "$ENGINE_OUT" "合格 ❌" "赤のまま放置を出す"

# (c) 木が変わっている → 最新 ❌（合格とは別の欄で出る）
printf '{"at":"2026-01-01T00:00:00Z","result":"pass","scriptsTree":"0000000000000000000000000000000000000000"}\n' > "$WORK/root/logs/thing-runs.jsonl"
run_engine --evidence
assert_contains "$ENGINE_OUT" "合格 ✅" "合格は合格のまま"
assert_contains "$ENGINE_OUT" "最新 ❌" "木が変わったことを別の欄で出す"

# (d) 記録に木のハッシュが無い → 最新は「？」（緑にも赤にもしない）
printf '{"at":"2026-01-01T00:00:00Z","result":"pass"}\n' > "$WORK/root/logs/thing-runs.jsonl"
run_engine --evidence
assert_contains "$ENGINE_OUT" "最新 ？" "判定できないことを緑にも赤にもしない"

# (e) 記録を持たない役割は、持たない理由を出す
write_registry "$(printf '%s' "$GOOD" | sed 's#"evidence": \[{ "name": "全件実行", "log": "logs/thing-runs.jsonl", "watch": \["scripts"\] }\]#"evidence": [], "unmeasuredReason": "毎回の CI で回るので記録を持たない"#')"
run_engine --evidence
assert_contains "$ENGINE_OUT" "毎回の CI で回るので記録を持たない" "持たない理由を出す"
write_registry "$GOOD"

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
MINIMAL_CONTRACT='"guardIds": [], "guardIdsReason": "なし", "preconditions": "なし", "evidence": [], "unmeasuredReason": "なし", "falsification": "scripts/check-thing.test.sh"'
TWO='{
  "id": "H-01", "role": "あ", "guards": "a", "trigger": "機械", "triggerDetail": "b",
  "entrypoints": ["scripts/entry.sh"], "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [], "limitsDoc": "docs/limits.md", '"$MINIMAL_CONTRACT"'
},
{
  "id": "H-02", "role": "い", "guards": "a", "trigger": "機械", "triggerDetail": "b",
  "entrypoints": ["scripts/entry.sh"], "checks": ["scripts/check-thing.test.sh"],
  "ledgers": [], "limitsDoc": "docs/limits.md", '"$MINIMAL_CONTRACT"'
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
