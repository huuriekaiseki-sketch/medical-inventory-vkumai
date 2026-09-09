#!/bin/bash
# WHY: 「ルールを常時ロードから外す」判断の安全網。
# 既存の scripts/check-hook-doc-pointers.test.sh は **検査 → ルール**（検査が指す節が実在するか）
# しか見ておらず、逆方向（**この節を守る検査があるか**）は誰も見ていなかった。
# そのため common.md を圧縮するたびに「読まれなくなったが検査も無い」ルールが生まれうる。
#
# 検査本体は scripts/lib/check-rule-guard-coverage.mjs。ここはその構造テスト。
#
# 実行: bash scripts/check-rule-guard-coverage.test.sh
set -euo pipefail

export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKER="$ROOT/scripts/lib/check-rule-guard-coverage.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# fixture の骨格を作る（root を差し替えて検査できる）
setup_fixture() {
  rm -rf "$TMP/fx"
  mkdir -p "$TMP/fx/docs/agents" "$TMP/fx/scripts" "$TMP/fx/.claude/workflows" "$TMP/fx/.claude/rules" "$TMP/fx/.github/workflows"
  cat > "$TMP/fx/docs/agents/undetectable-rules-inventory.md" <<'MD'
# 検知手段のないルールの棚卸し

| ルール | 所在 | 備考 |
|---|---|---|
| 宣言済みのやつ | [`common.md`](./common.md)「宣言済みルール」 | 検知手段が無い |
MD
}

echo "=== scenario 1: 検査スクリプトが存在する ==="
if [ -f "$CHECKER" ]; then
  ok "存在する: scripts/lib/check-rule-guard-coverage.mjs"
else
  ng "存在しない: $CHECKER"
fi

echo "=== scenario 2: 実態のリポジトリに穴が無い ==="
if out="$(cd "$ROOT" && node "$CHECKER" 2>&1)"; then
  ok "穴なし: ${out}"
else
  ng "実態に守られていないルールがある" "$out"
fi

echo "=== scenario 3: 検査が名指ししていれば「守」と数える ==="
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 分野A

### 守られているルール

本文。
MD
cat > "$TMP/fx/scripts/check-something.sh" <<'SH'
#!/bin/bash
MSG="詳細は docs/agents/common.md「守られているルール」を参照"
SH
if (cd "$TMP/fx" && node "$CHECKER" >/dev/null 2>&1); then
  ok "検査が名指しした節は通る"
else
  ng "名指ししているのに穴と判定された" "$(cd "$TMP/fx" && node "$CHECKER" --verbose 2>&1)"
fi

echo "=== scenario 4: 検査が無ければ落ちる（RED 方向の自己検証） ==="
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 分野A

### 誰も守っていないルール

本文。
MD
if out="$(cd "$TMP/fx" && node "$CHECKER" 2>&1)"; then
  ng "守る検査が無いのに通ってしまった" "$out"
else
  ok "守る検査が無い節を検知して終了コード 1"
  if echo "$out" | grep -q '誰も守っていないルール'; then
    ok "節名を名指しする"
  else
    ng "節名が出ていない" "$out"
  fi
  if echo "$out" | grep -q 'undetectable-rules-inventory.md'; then
    ok "直し方（登録先）を出す"
  else
    ng "直し方が出ていない" "$out"
  fi
fi

echo "=== scenario 5: 棚卸しに登録すれば通る（穴を可視化する道） ==="
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 分野A

### 宣言済みルール

本文。
MD
if (cd "$TMP/fx" && node "$CHECKER" >/dev/null 2>&1); then
  ok "undetectable-rules-inventory.md に登録された節は通る"
else
  ng "登録済みなのに穴と判定された" "$(cd "$TMP/fx" && node "$CHECKER" --verbose 2>&1)"
fi

echo "=== scenario 6: 分野の見出し（##）はルールとして数えない ==="
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 誰も守っていない分野

リード文だけ。

### 宣言済みルール

本文。
MD
if (cd "$TMP/fx" && node "$CHECKER" >/dev/null 2>&1); then
  ok "分野の見出し（##）は対象外"
else
  ng "分野の見出しをルールとして数えている" "$(cd "$TMP/fx" && node "$CHECKER" --verbose 2>&1)"
fi

echo "=== scenario 7: 節の中の小見出し（####）も数えない ==="
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 分野A

### 宣言済みルール

本文。

#### 誰も守っていない小見出し

本文。
MD
if (cd "$TMP/fx" && node "$CHECKER" >/dev/null 2>&1); then
  ok "節の中の小見出し（####）は対象外"
else
  ng "小見出しをルールとして数えている" "$(cd "$TMP/fx" && node "$CHECKER" --verbose 2>&1)"
fi

echo "=== scenario 8: NOT_RULES の各項目に理由が書いてある ==="
# 「面倒だから対象外にする」を防ぐ。理由が空の項目があれば落とす
NOT_RULES_JSON="$(cd "$ROOT" && node -e '
import("./scripts/lib/check-rule-guard-coverage.mjs").then((m) => {
  console.log(JSON.stringify(m.loadRegistry(process.cwd()).notRules))
})')"
empty="$(printf '%s' "$NOT_RULES_JSON" | node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const o = JSON.parse(s)
  const bad = Object.entries(o).filter(([, v]) => !v || String(v).trim().length < 10)
  console.log(bad.map(([k]) => k).join(","))
})')"
if [ -z "$empty" ]; then
  ok "対象外にした節すべてに理由がある"
else
  ng "理由が無い（または短すぎる）対象外の節がある: $empty"
fi

echo "=== scenario 9: check-hook-doc-pointers と逆方向であることの確認 ==="
# 片方向だけでは「検査が存在しないルール」を見つけられないことを、fixture で示す。
# pointers 側は「検査が指す節が実在するか」なので、検査が 1 本も無ければ何も言わない。
setup_fixture
cat > "$TMP/fx/docs/agents/common.md" <<'MD'
# 共通ルール

## 分野A

### 誰も守っていないルール

本文。
MD
# 検査が 1 本も無い状態: pointers 側は違反 0、こちらは違反 1 になるはず
if (cd "$TMP/fx" && node "$CHECKER" >/dev/null 2>&1); then
  ng "検査ゼロの状態を見逃した（逆方向になっていない）"
else
  ok "検査が 1 本も無い状態を穴として検知する（pointers 側では気づけない）"
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "FAILED"
  exit 1
fi
