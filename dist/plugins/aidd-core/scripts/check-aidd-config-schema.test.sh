#!/bin/bash
# WHY(2026-09-12): スキーマ（scripts/lib/aidd-config.schema.json）は配っていたのに、
#      **中身を検証する検査が 1 本も無かった**。参照していたのは「配布物に含まれるか」を
#      見る 2 か所だけで、設定がスキーマから静かにずれても誰も気づけない。
#
#      実証: 同じ日に導入先ひな形へ `errorResponse` を足したとき、`_comment` を書いた。
#      ところが errorResponse は `additionalProperties: false` で `_comment` を許しておらず
#      （faultInjectionDrill と controlBytes は許している）、**スキーマ違反のまま緑で通った**。
#      検査が無い場所は、書いた本人が通り抜けてしまう。
#
# 何を見るか:
#   (a) 導入先の aidd.config.json がスキーマに適合する（無ければ対象なし）
#   (b) 配っているひな形がスキーマに適合する（limits は**わざと未確定**なので外す。
#       雛形のままを落とす役は check-design-answers.test.sh が別に持つ）
#   (c) fixture で違反を検知できる（RED 方向の自己検証）
#   (d) 検証器が知らない語彙をスキーマに見つけたら落ちる（黙って素通りさせない）
#
# 実行: bash scripts/check-aidd-config-schema.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY: 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**の設定を見る（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
VALIDATOR="$SCRIPT_DIR/lib/validate-aidd-config.mjs"
# WHY(2026-09-12): スキーマの置き場は**配る形と使う形で違う**。中心リポジトリでは
#      scripts/lib/ にあるが、配布物では <プラグイン>/schema/ へ移る（plugin-layout の schema 節）。
#      片方だけを見ると、配られた先でだけ「スキーマが無い」と言う——C-053 そのもので、
#      この検査を書いた本人が同じ穴を作った（導入先で実測して発覚）。両方を探す。
SCHEMA=""
for s in "$SCRIPT_DIR/lib/aidd-config.schema.json" "$SCRIPT_DIR/../schema/aidd-config.schema.json"; do
  [ -f "$s" ] && { SCHEMA="$s"; break; }
done

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

if [ ! -f "$VALIDATOR" ] || [ -z "$SCHEMA" ]; then
  # WHY(2026-09-12): ここは `$SCHEMA）` と書いていた。全角括弧に隣接した裸の変数は
  #      ロケールによっては括弧の 1 バイト目まで名前として読まれ、`unbound variable` で死ぬ。
  #      check-shell-locale-safety が検知するために作られた、まさにその書き方を自分でやった。
  #      しかもこの行は**壊れたときにしか通らない道**なので、中心リポジトリでは一度も実行されず、
  #      導入先で初めて出た。`${VAR}` と書く。
  ng "検証器かスキーマが見つからない（validator=${VALIDATOR} schema=${SCHEMA:-見つからず}）"
  echo "FAILED"
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "  SKIP: 対象なし（node が無いので検証できない）"; echo "ALL PASSED"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 導入先の aidd.config.json がスキーマに適合する ==="
CONFIG="$REPO_ROOT/aidd.config.json"
if [ ! -f "$CONFIG" ]; then
  ok "対象なし（この導入先は aidd.config.json を持たない）"
else
  # WHY(2026-09-12): limits は「まだ人に聞いていない」間はひな形のまま（decidedOn が TODO）で、
  #      その状態を違反として読むと**入れたばかりの導入先が必ず赤くなる**（実測で両方の導入先が落ちた）。
  #      かといって一律に外すと、**limits を誰も見なくなる**——値の中身を見る
  #      check-design-answers.test.sh は配っていない（checksNotDistributed。根が固定で、
  #      配ってもプラグイン自身を見るため）ので、導入先では本当に誰も見ない。
  #      一度「外して別の検査に任せた」と書いたが、その別の検査が配られていないことを
  #      確かめていなかった。**役割を分けるときは、相手が配る側に居るかを見る。**
  #      そこで「まだ聞いていない」と「埋めたが形が違う」を分ける:
  #      decidedOn が TODO（または無し）のうちは limits を外し、埋まったらスキーマで見る。
  DECIDED="$(node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.limits?.decidedOn ?? ""))' "$CONFIG" 2>/dev/null || true)"
  if [ -z "$DECIDED" ] || [ "$DECIDED" = "TODO" ]; then
    SKIP_ARGS=(--skip limits)
    LABEL="適合している（limits はまだ人に聞いていない印なので外した。decidedOn=${DECIDED:-無し}）"
  else
    SKIP_ARGS=()
    LABEL="適合している（limits の値も含めて。decidedOn=${DECIDED}）"
  fi
  OUT="$(node "$VALIDATOR" "$CONFIG" "$SCHEMA" ${SKIP_ARGS[@]+"${SKIP_ARGS[@]}"} 2>&1)"
  if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then
    ok "$LABEL"
  else
    ng "スキーマに合わない項目がある" "$OUT"
  fi
fi

echo "=== scenario 2: 配っているひな形がスキーマに適合する（limits は未確定なので外す） ==="
# WHY: ひな形の limits は 0 と TODO のまま置く。人に聞くまで進ませないための仕掛けで、
#      そこを落とす役は check-design-answers.test.sh。ここで見るのは型と未知キーだけ。
TPL=""
for c in "$SCRIPT_DIR/../templates/consumer/aidd.config.json" \
         "$REPO_ROOT/docs/plugin/templates/consumer/aidd.config.json"; do
  [ -f "$c" ] && { TPL="$c"; break; }
done
if [ -z "$TPL" ]; then
  ok "対象なし（この木は導入先ひな形を持たない）"
else
  OUT="$(node "$VALIDATOR" "$TPL" "$SCHEMA" --skip limits 2>&1)"
  if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then
    ok "ひな形は適合している（${TPL#"$REPO_ROOT"/}）"
  else
    ng "ひな形がスキーマに合わない" "$OUT"
  fi
fi

echo "=== scenario 3: fixture で違反を検知できる（RED 方向の自己検証） ==="
cat > "$WORK/unknown-key.json" <<'EOF'
{ "risk": { "keywords": ["a"] }, "ぜんぜん知らない項目": 1 }
EOF
cat > "$WORK/wrong-type.json" <<'EOF'
{ "readonlyAgentTypes": "配列であるべきところに文字列" }
EOF
cat > "$WORK/too-small.json" <<'EOF'
{ "limits": { "decidedOn": "2026-01-01", "textLength": { "memo": 0 }, "requestsPerMinute": 5, "invitesPerDay": 5 } }
EOF
cat > "$WORK/missing-required.json" <<'EOF'
{ "limits": { "decidedOn": "2026-01-01" } }
EOF

check_detects() { # $1=fixture, $2=期待する語, $3=ラベル
  local out
  out="$(node "$VALIDATOR" "$1" "$SCHEMA" 2>&1)"
  if grep -qF -- "$2" <<<"$out"; then ok "検知: $3"; else ng "検知できない: $3" "$out"; fi
}
check_detects "$WORK/unknown-key.json" 'スキーマに無い項目' '未知のキー'
check_detects "$WORK/wrong-type.json" '型が array でない' '型違い'
check_detects "$WORK/too-small.json" '1 未満' '下限割れ'
check_detects "$WORK/missing-required.json" '必須の' '必須項目の欠落'

echo "=== scenario 3b: 正しい設定は 1 件も出さない（誤検知しない。対を置く） ==="
cat > "$WORK/good.json" <<'EOF'
{
  "risk": { "keywords": ["auth"], "pathPrefixes": ["db/"], "domainKeywords": ["<ドメイン語>"] },
  "readonlyAgentTypes": ["reviewer"],
  "commands": { "test": "<テストコマンド>" },
  "limits": {
    "decidedOn": "2026-01-01",
    "textLength": { "memo": 200 },
    "requestsPerMinute": 60,
    "invitesPerDay": 10
  }
}
EOF
OUT="$(node "$VALIDATOR" "$WORK/good.json" "$SCHEMA" 2>&1)"
if [ "$(tail -n1 <<<"$OUT")" = "violations=0" ]; then ok "誤検知なし"; else ng "正しい設定を違反と読む" "$OUT"; fi

echo "=== scenario 4: 検証器が知らない語彙をスキーマに見つけたら落ちる（fail-open 防止） ==="
# WHY(C-025): 実装が追いつかない語彙を黙って読み飛ばすと、**検証したつもりの緑**になる。
python3 - "$SCHEMA" "$WORK/future-schema.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    schema = json.load(f)
schema["properties"]["risk"]["oneOf"] = [{"type": "object"}]
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(schema, f, ensure_ascii=False)
PY
OUT="$(node "$VALIDATOR" "$WORK/good.json" "$WORK/future-schema.json" 2>&1)"
RC=$?
if grep -qF -- '知らない語彙' <<<"$OUT" && [ "$RC" -ne 0 ]; then
  ok "知らない語彙があれば落ちる（実装を足すまで通さない）"
else
  ng "知らない語彙を黙って読み飛ばす" "rc=${RC} ${OUT}"
fi

echo "=== scenario 5: 設定が無ければ対象なしとして通る（持っていないだけで赤くしない） ==="
OUT="$(node "$VALIDATOR" "$WORK/no-such.json" "$SCHEMA" 2>&1)"
RC=$?
if grep -qF -- '対象なし' <<<"$OUT" && [ "$RC" -eq 0 ]; then
  ok "対象なしと言って通る"
else
  ng "設定が無いだけで落ちる" "rc=${RC} ${OUT}"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
