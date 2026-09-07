#!/usr/bin/env bash
# WHY: 上限や項目名は**リポジトリごとに違う**。この製品では「術式名」「患者 ID」だが、別の製品では
#      「受注者名」「本文」になる。2026-09-07 の点検で、値を AI が既定値で埋めていたために
#      1 MB の入力が通り、施設が消せなくなり、一覧が 50 人で切れていた。
#      **同じ失敗を派生先で繰り返さない**ために、値は設定（aidd.config.json の limits）に持たせ、
#      埋まっていない・置き換え忘れ・人が決めていないものがあれば止める。
#
#   (a) limits がある。必須のキーが揃っている
#   (b) 値が置き換え忘れでない（TODO・0・null・雛形のままの文言）
#   (c) 人が決めたことが分かる（decidedBy があり、AI が入れた印ではない）
#   (d) 決めた日がある。古すぎる（2 年以上前）なら棚卸しを促す
#   (e) 設計の質問集（docs/agents/design-questions.md）が設定を指している
#   (f) fixture で (a)〜(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-design-answers.test.sh
# 環境変数（テスト用注入ポイント）: AIDD_CONFIG_PATH
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="${AIDD_CONFIG_PATH:-$REPO_ROOT/aidd.config.json}"
QUESTIONS="$REPO_ROOT/docs/agents/design-questions.md"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

check_limits() {
  node -e '
const fs = require("fs")
const p = process.argv[1]
if (!fs.existsSync(p)) { console.log("config: " + p + " が無い"); process.exit(0) }
let cfg
try { cfg = JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { console.log("config: JSON として読めない"); process.exit(0) }

const l = cfg.limits
if (!l) { console.log("missing: limits が無い（作る前に聞く質問の答えを書く）"); process.exit(0) }

for (const key of ["decidedOn", "textLength", "requestsPerMinute", "invitesPerDay"]) {
  if (l[key] === undefined || l[key] === null) console.log(`missing: limits.${key} が無い`)
}

// 置き換え忘れの検知。雛形のままの文言・0・空を許さない
const placeholder = /^(todo|tbd|未定|xxx|\?+|-)$/i
const flat = (obj, prefix) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const name = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object") { flat(v, name); continue }
    if (typeof v === "string" && (v.trim() === "" || placeholder.test(v.trim()))) {
      console.log(`placeholder: limits.${name} が雛形のまま（「${v}」）`)
    }
    if (typeof v === "number" && !(v > 0)) {
      console.log(`placeholder: limits.${name} が ${v}（1 以上の値を人が決める）`)
    }
  }
}
flat(l, "")

if (l.textLength && Object.keys(l.textLength).length === 0) {
  console.log("placeholder: limits.textLength が空（列の役割ごとに上限を書く）")
}

if (!l.decidedBy || String(l.decidedBy).trim() === "") {
  console.log("who: limits.decidedBy が無い（誰が決めたかを書く。AI の既定値を値として認めない）")
} else if (/^(ai|claude|default|既定|自動)/i.test(String(l.decidedBy).trim())) {
  console.log(`who: limits.decidedBy が「${l.decidedBy}」（人が決めた値だけを認める）`)
}

if (l.decidedOn) {
  const d = new Date(String(l.decidedOn))
  if (Number.isNaN(d.getTime())) {
    console.log(`date: limits.decidedOn が日付として読めない（「${l.decidedOn}」）`)
  } else {
    const years = (Date.now() - d.getTime()) / (365 * 24 * 60 * 60 * 1000)
    if (years > 2) console.log(`stale: limits.decidedOn が ${l.decidedOn}（2 年以上前。棚卸しの合図）`)
  }
}
' "$1"
}

echo "=== scenario 1: 実態の設定に決めた値が揃っている ==="
OUT="$(check_limits "$CONFIG")"
if [ -z "$OUT" ]; then
  assert_ok "limits が揃っていて、人が決めた印がある"
else
  assert_fail "設計時に決める値が埋まっていない" "$OUT
      docs/agents/design-questions.md の質問を人に聞き、aidd.config.json の limits に書く"
fi

echo "=== scenario 2: 質問集が設定を指している ==="
if grep -q 'aidd.config.json' "$QUESTIONS" 2>/dev/null; then
  assert_ok "design-questions.md が設定の場所を書いている"
else
  assert_fail "design-questions.md に値の置き場所（aidd.config.json の limits）が書かれていない"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf '{}\n' > "$WORK/no-limits.json"
OUT="$(check_limits "$WORK/no-limits.json")"
if printf '%s' "$OUT" | grep -q 'missing: limits が無い'; then assert_ok "limits 無しを検知"; else assert_fail "limits 無しを検知できない" "$OUT"; fi

cat > "$WORK/placeholder.json" <<'EOF'
{
  "limits": {
    "decidedOn": "2026-09-07",
    "decidedBy": "AI（既定値）",
    "textLength": { "title": 0 },
    "requestsPerMinute": 300,
    "invitesPerDay": 50
  }
}
EOF
OUT="$(check_limits "$WORK/placeholder.json")"
if printf '%s' "$OUT" | grep -q 'placeholder: limits.textLength.title'; then assert_ok "0 の値を検知"; else assert_fail "0 を検知できない" "$OUT"; fi
if printf '%s' "$OUT" | grep -q 'who: limits.decidedBy'; then assert_ok "AI が決めた印を検知"; else assert_fail "decidedBy を検知できない" "$OUT"; fi

cat > "$WORK/todo.json" <<'EOF'
{
  "limits": {
    "decidedOn": "1990-01-01",
    "decidedBy": "TODO",
    "textLength": { "title": 100 },
    "requestsPerMinute": 300
  }
}
EOF
OUT="$(check_limits "$WORK/todo.json")"
if printf '%s' "$OUT" | grep -q 'placeholder: limits.decidedBy'; then assert_ok "TODO のままを検知"; else assert_fail "TODO を検知できない" "$OUT"; fi
if printf '%s' "$OUT" | grep -q 'missing: limits.invitesPerDay'; then assert_ok "キー不足を検知"; else assert_fail "キー不足を検知できない" "$OUT"; fi
if printf '%s' "$OUT" | grep -q 'stale: limits.decidedOn'; then assert_ok "古い決定日を検知"; else assert_fail "古い決定日を検知できない" "$OUT"; fi

cat > "$WORK/good.json" <<'EOF'
{
  "limits": {
    "decidedOn": "2026-09-07",
    "decidedBy": "Masanori",
    "textLength": { "title": 200 },
    "requestsPerMinute": 300,
    "invitesPerDay": 50
  }
}
EOF
OUT="$(check_limits "$WORK/good.json")"
if [ -z "$OUT" ]; then assert_ok "正しい設定は誤検知しない"; else assert_fail "正しい設定を違反にした" "$OUT"; fi

echo "=== scenario 4: 設定の値と質問集の「決めた値」表が食い違っていない ==="
# WHY: 設定だけ直して表を直さない（またはその逆）と、次に読む人がどちらを信じるか分からなくなる。
#      数値そのものが表に現れることだけを見る（書式は自由。1000 と 1,000 の両方を許す）。
NUMS="$(node -e '
const fs = require("fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const l = cfg.limits || {}
const rows = []
if (l.requestsPerMinute) rows.push(["requestsPerMinute", l.requestsPerMinute])
if (l.invitesPerDay) rows.push(["invitesPerDay", l.invitesPerDay])
for (const [k, v] of Object.entries(l.textLength || {})) rows.push(["textLength." + k, v])
const comma = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ",")
for (const [k, v] of rows) console.log(k + " " + v + " " + comma(v))
' "$CONFIG")"
TABLE="$(sed -n '/^## 決めた値/,$p' "$QUESTIONS" 2>/dev/null)"
missing=""
while read -r key val alt; do
  [ -z "${val:-}" ] && continue
  if ! printf '%s' "$TABLE" | grep -qE "(^|[^0-9,])($val|$alt)([^0-9,]|$)"; then
    missing="$missing $key=$val"
  fi
done <<< "$NUMS"
if [ -z "$missing" ]; then
  assert_ok "設定の値が「決めた値」表にすべて現れている"
else
  assert_fail "設定にあるのに「決めた値」表に無い値がある" "$missing
      aidd.config.json を変えたら docs/agents/design-questions.md の表も直す"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
