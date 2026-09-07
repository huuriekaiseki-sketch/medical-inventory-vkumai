#!/bin/bash
# WHY: scripts/lib/aidd-config.sh（aidd.config.json を hook から読む共通関数、issue #420 v1 セット B2）の
# 回帰テスト。探索順（環境変数 → ルートヒント → git ルート → レイアウト）と fail-open
# （ファイル無し・壊れた JSON・null → 既定値）を固定する。
#
# 実行: bash scripts/lib/aidd-config.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/aidd-config.sh"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else echo "  NG: $3 (expected=$2 actual=$1)"; fail=1; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 環境変数 AIDD_CONFIG_FILE が最優先 ==="
printf '{"docs":{"domain":"custom/domain.md"}}\n' > "$WORK/custom.json"
OUT="$(AIDD_CONFIG_FILE="$WORK/custom.json" aidd_config_query '.docs.domain' 'default')"
assert_eq "$OUT" "custom/domain.md" "環境変数のファイルから読む"

echo "=== scenario 2: ルートヒント直下の aidd.config.json を使う ==="
mkdir -p "$WORK/repo"
printf '{"docs":{"domain":"hint/domain.md"}}\n' > "$WORK/repo/aidd.config.json"
OUT="$(env -u AIDD_CONFIG_FILE bash -c "source '$SCRIPT_DIR/aidd-config.sh'; aidd_config_query '.docs.domain' 'default' '$WORK/repo'")"
assert_eq "$OUT" "hint/domain.md" "ルートヒントのファイルから読む"

echo "=== scenario 3: ヒント無しならこのリポジトリ直下の aidd.config.json（実物） ==="
OUT="$(env -u AIDD_CONFIG_FILE bash -c "source '$SCRIPT_DIR/aidd-config.sh'; aidd_config_query '.docs.domain' 'default'")"
assert_eq "$OUT" "docs/agents/domain.md" "実物の値が読める"

echo "=== scenario 4: PATH 上の git がフェイクでもレイアウトから解決できる ==="
mkdir -p "$WORK/fakebin"
printf '#!/bin/bash\nexit 0\n' > "$WORK/fakebin/git"
chmod +x "$WORK/fakebin/git"
OUT="$(env -u AIDD_CONFIG_FILE PATH="$WORK/fakebin:$PATH" bash -c "source '$SCRIPT_DIR/aidd-config.sh'; aidd_config_query '.docs.domain' 'default'")"
assert_eq "$OUT" "docs/agents/domain.md" "git 無効でもレイアウトで解決"

echo "=== scenario 5: ファイルが無い → 既定値 ==="
OUT="$(AIDD_CONFIG_FILE="$WORK/none.json" aidd_config_query '.docs.domain' 'default')"
assert_eq "$OUT" "default" "既定値"

echo "=== scenario 6: 壊れた JSON → 既定値（fail-open） ==="
printf '{broken\n' > "$WORK/broken.json"
OUT="$(AIDD_CONFIG_FILE="$WORK/broken.json" aidd_config_query '.docs.domain' 'default')"
assert_eq "$OUT" "default" "既定値"

echo "=== scenario 7: キーが無く null になる → 既定値 ==="
OUT="$(AIDD_CONFIG_FILE="$WORK/custom.json" aidd_config_query '.docs.decisions' 'default')"
assert_eq "$OUT" "default" "null は既定値に置き換える"

echo "=== scenario 8: 配列の join も読める ==="
printf '{"readonlyAgentTypes":["a","b"]}\n' > "$WORK/roles.json"
OUT="$(AIDD_CONFIG_FILE="$WORK/roles.json" aidd_config_query '.readonlyAgentTypes // [] | join(" ")' '')"
assert_eq "$OUT" "a b" "配列を空白区切りで受け取れる"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
