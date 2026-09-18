#!/usr/bin/env bash
# WHY: ルールブック（カタログ）の形を、1 本のエンジンで全件検査する。
#      これまでは新しいルールブックを足すたびに 150 行の bash を書き写しており、写すたびに
#      検査の中身が少しずつ違っていた（重複 ID を見ない・パスの実在を見ない等）。
#      エンジン（scripts/lib/check-catalog.mjs）と登録簿（scripts/lib/catalog-registry.json）に分け、
#      新しいルールブックは登録簿の 1 エントリと文書だけで検査対象に入る。
#
#   (a) 登録簿の全ルールブックに違反が無い
#   (b) 登録簿のエントリが指す文書が実在する
#   (c) fixture でエンジンが各違反（列数・ID の形・重複・帯・状態の語彙・計画番号・
#       守るテスト無し・パス不在）を検知できる（RED 方向の自己検証）
#   (d) 正しい fixture は 1 件も誤検知しない
#   (e) 索引（docs/agents/rulebooks.md）が登録簿から作り直した内容と一致する
#
# 実行: bash scripts/check-catalogs.test.sh
# 環境変数（テスト用注入ポイント）: CATALOG_REGISTRY
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/check-catalog.mjs"
REGISTRY="${CATALOG_REGISTRY:-$SCRIPT_DIR/lib/catalog-registry.json}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

echo "=== scenario 1: 登録簿の全ルールブックに違反が無い ==="
OUT="$(node "$ENGINE" "$REGISTRY" --root "$REPO_ROOT")"
LAST="$(tail -n1 <<<"$OUT")"
COUNT="$(node -e '
const fs = require("fs")
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
console.log((r.catalogs ?? []).length)
' "$REGISTRY")"
if [ "$LAST" = "violations=0" ]; then
  assert_ok "違反なし（ルールブック ${COUNT} 件）"
else
  assert_fail "違反あり" "$OUT"
fi

echo "=== scenario 2: 登録簿の文書が実在する ==="
MISSING="$(node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[2]
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const c of r.catalogs ?? []) {
  if (!fs.existsSync(path.join(root, c.file))) console.log(c.id + ": " + c.file)
}
' "$REGISTRY" "$REPO_ROOT")"
if [ -z "$MISSING" ]; then assert_ok "全て実在する"; else assert_fail "登録簿が指す文書が無い" "$MISSING"; fi

echo "=== scenario 3: fixture で各違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SPEC='{"id":"fixture","idPrefix":"Z","columns":4,"evidenceColumn":3,"statusColumn":4,"states":["済み","計画","対象外"],"evidenceRequiredStates":["済み"],"planRequiredStates":["計画"],"planPattern":"#[0-9]+-[0-9]+","idBands":[0,10],"limits":"fixture 用。表の形しか見ないので中身の妥当性は見ない"}'

cat > "$WORK/bad.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 正常 | `package.json` | 済み |
| Z-002 | 正常（計画に番号あり） | 未 | 計画（#757-99） |
| Z-003 | 計画に番号なし | 未 | 計画 |
| Z-004 | 済みなのに守るテストなし | 未 | 済み |
| Z-005 | 状態が語彙にない | 未 | たぶん済み |
| Z-006 | 不在パス | `scripts/no-such.sh` | 済み |
| Z-99 | 桁不足 | `package.json` | 済み |
| Z-001 | 重複 | `package.json` | 済み |
| Z-030 | 帯の外 | `package.json` | 済み |
| Z-007 | 列ずれ | 済み |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF

OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/bad.md" --root "$REPO_ROOT")"
for needle in \
  'plan: \[Z-003\]' \
  'evidence: \[Z-004\]' \
  'status: \[Z-005\]' \
  'path: \[Z-006\]' \
  'id: \[Z-99\]' \
  'id: \[Z-001\] ID が重複' \
  'band: \[Z-030\]' \
  'columns: \[Z-007\]' \
; do
  if grep -qE "$needle" <<<"$OUT"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle" "$OUT"; fi
done
if grep -q 'Z-002' <<<"$OUT"; then
  assert_fail "計画番号がある行を誤検知" "$OUT"
else
  assert_ok "計画番号がある行は誤検知しない"
fi

echo "=== scenario 4: 正しい fixture は 1 件も出さない ==="
cat > "$WORK/good.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 正常 | `package.json` | 済み |
| Z-010 | 別の帯 | 未 | 計画（#757-99） |
| Z-011 | 対象外 | 未 | 対象外 |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/good.md" --root "$REPO_ROOT")"
if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then
  assert_ok "誤検知なし"
else
  assert_fail "正しい fixture を違反にした" "$OUT"
fi

echo "=== scenario 4c: 節と ID の帯の食い違いを検知する（2026-09-09 に実際にやった間違い） ==="
# WHY: 更新ルールの「区分ごとに 10 刻み」は**書いてあるだけ**で、誰も突き合わせていなかった。
#      状態遷移の節に 06x の ID を振っても 15 本のルールブック検査は 1 つも落ちず、
#      更新ルールを読み直して初めて気づいた（C-010: 印を実態と突き合わせていない）。
cat > "$WORK/mixed.md" <<'EOF'
## 状態遷移

| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | この節の帯は 00x | `package.json` | 済み |
| Z-060 | **別の帯を紛れ込ませた** | `package.json` | 済み |

## 入力の長さ

| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-061 | この節の帯は 06x | `package.json` | 済み |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF
SPEC_BANDS='{"id":"fixture","idPrefix":"Z","columns":4,"evidenceColumn":3,"statusColumn":4,"states":["済み","計画","対象外"],"evidenceRequiredStates":["済み"],"idBands":[0,60],"limits":"fixture 用。表の形しか見ないので中身の妥当性は見ない"}'
OUT="$(node "$ENGINE" --spec "$SPEC_BANDS" --file "$WORK/mixed.md" --root "$REPO_ROOT")"
if grep -q '節「状態遷移」に帯が 2 つ混ざっている' <<<"$OUT"; then
  assert_ok "節に別の帯が紛れたら検知"
else
  assert_fail "節と帯の食い違いを検知できない" "$OUT"
fi
if grep -q '帯 60x が 2 つの節に散っている' <<<"$OUT"; then
  assert_ok "同じ帯が 2 つの節に散っているのも検知（逆向き）"
else
  assert_fail "帯が散っているのを検知できない" "$OUT"
fi

# WHY(節が 1 つなら掛けない): 1 つの節に全部の帯を並べる書き方も正しい
#      （check-design-pitfalls.md がその形。帯の意味は更新ルールの文章にある）
cat > "$WORK/single-section.md" <<'EOF'
## 一覧

| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 帯 00x | `package.json` | 済み |
| Z-060 | 帯 06x | `package.json` | 済み |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF
OUT="$(node "$ENGINE" --spec "$SPEC_BANDS" --file "$WORK/single-section.md" --root "$REPO_ROOT")"
if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then
  assert_ok "節が 1 つなら帯が混ざっていても違反にしない"
else
  assert_fail "1 節に並べる書き方を違反にした" "$OUT"
fi

echo '=== scenario 4b: エスケープしたパイプ（\|）は区切りにしない。正しい markdown を違反にしない ==='
# WHY(2026-09-07): fail-open-inventory.md を登録しようとしたら列数の違反が 6 件出た。
#      中身は `` `error \|\| !user` `` のように **markdown のエスケープで内容としてのパイプ**を
#      書いた行で、描画すれば 1 セルになる。素の split('|') は区切りと区別できず、
#      **正しい表を違反と報告していた**。登録済みの 7 件がたまたま使っていなかったので気づけなかった。
cat > "$WORK/escaped.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | `error \|\| !user` で拒否する | `package.json` | 済み |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/escaped.md" --root "$REPO_ROOT")"
if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then
  assert_ok "エスケープしたパイプを含む行を誤検知しない"
else
  assert_fail "エスケープしたパイプで列数を誤判定した" "$OUT"
fi

# 逆に、エスケープしていない素のパイプは今までどおり列がずれるので違反になる
cat > "$WORK/raw-pipe.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | error || !user で拒否する | `package.json` | 済み |

## 限界

表の形（列・ID・状態の語彙）しか見ないので、書かれている中身が正しいかは見ない。
EOF
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/raw-pipe.md" --root "$REPO_ROOT")"
if grep -q 'columns:' <<<"$OUT"; then
  assert_ok "エスケープしていない素のパイプは今までどおり違反"
else
  assert_fail "素のパイプを見逃した" "$OUT"
fi

echo "=== scenario 5: 行が 1 つも無いルールブックは違反にする（空の登録を許さない） ==="
printf '| ID | 内容 |\n| --- | --- |\n\n## 限界\n\n表の形しか見ないので、中身が正しいかは見ない。\n' > "$WORK/empty.md"
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/empty.md" --root "$REPO_ROOT")"
if grep -q '行が 1 つも無い' <<<"$OUT"; then
  assert_ok "空のルールブックを検知"
else
  assert_fail "空を検知できない" "$OUT"
fi

echo "=== scenario 6: 「限界」を書いていないルールブックは通さない ==="
# WHY: 2026-09-07。ルールブックは増える一方で、リポジトリごとに中身も変わる。
#      「このルールが何を守らないか」を後から思い出すのは無理なので、先に書かせる。
#      取りこぼしが起きたときに「あの限界ではないか」と最初に疑えるのが目的。
printf '| ID | 内容 | 守るテスト | 状態 |\n| --- | --- | --- | --- |\n| Z-001 | 正常 | `package.json` | 済み |\n' > "$WORK/nolimits.md"
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/nolimits.md" --root "$REPO_ROOT")"
if grep -q '「## 限界」の節が無い' <<<"$OUT"; then
  assert_ok "限界の節が無いのを検知"
else
  assert_fail "限界の節が無いのを検知できない" "$OUT"
fi

cat > "$WORK/todolimits.md" <<'EOF'
| ID | 内容 | 守るテスト | 状態 |
| --- | --- | --- | --- |
| Z-001 | 正常 | `package.json` | 済み |

## 限界

TODO: あとで書く。ここに見つからないことを書く予定。
EOF
OUT="$(node "$ENGINE" --spec "$SPEC" --file "$WORK/todolimits.md" --root "$REPO_ROOT")"
if grep -q '「## 限界」が仮置きのまま' <<<"$OUT"; then
  assert_ok "仮置きの限界を検知"
else
  assert_fail "仮置きの限界を検知できない" "$OUT"
fi

SPEC_NO_LIMITS='{"id":"fixture","idPrefix":"Z","columns":4,"evidenceColumn":3,"statusColumn":4,"states":["済み","計画","対象外"],"idBands":[0,10]}'
OUT="$(node "$ENGINE" --spec "$SPEC_NO_LIMITS" --file "$WORK/good.md" --root "$REPO_ROOT")"
if grep -q '登録簿に limits' <<<"$OUT"; then
  assert_ok "登録簿の limits 未記入を検知（索引に空欄が出るのを防ぐ）"
else
  assert_fail "登録簿の limits 未記入を検知できない" "$OUT"
fi

echo "=== scenario 7: 索引が最新（登録簿から生成し直した内容と一致する） ==="
if OUT="$(bash "$SCRIPT_DIR/render-rulebook-index.sh" --check 2>&1)"; then
  assert_ok "索引は最新"
else
  assert_fail "索引が古い（bash scripts/render-rulebook-index.sh で作り直す）" "$OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
