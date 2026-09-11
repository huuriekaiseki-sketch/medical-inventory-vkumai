#!/bin/bash
# WHY: Claude Code / Codex 共存設計（docs/agents/claude-codex-coexistence-template.md）の
# 「設定ファイルの完全分離」「共有スクリプトのツール非依存」「Codex出力契約の違い」を
# 機械的に固定する回帰テスト。riff-gear/cardiosearchで実測した事故パターン
# （$CLAUDE_PROJECT_DIR依存でCodex hookが無言死・ask未対応・transcript形式依存）の再発防止。
#
# 実行: bash scripts/codex-config-separation.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_JSON="$REPO_ROOT/.codex/hooks.json"
CLAUDE_SETTINGS="$REPO_ROOT/.claude/settings.json"

fail=0
assert_ok() {
  local label="$1"
  echo "  OK: $label"
}
assert_fail() {
  local label="$1" detail="${2:-}"
  echo "  NG: $label"
  [ -n "$detail" ] && echo "      $detail"
  fail=1
}

echo "=== scenario 1: .codex/hooks.json が存在し有効なJSONである ==="
if [ -f "$HOOKS_JSON" ]; then
  assert_ok "存在する"
  if jq empty "$HOOKS_JSON" 2>/dev/null; then
    assert_ok "有効なJSON"
  else
    assert_fail "有効なJSON"
  fi
else
  assert_fail ".codex/hooks.json が存在しない"
fi

echo "=== scenario 2: .codex/配下に \$CLAUDE_PROJECT_DIR 等のClaude専用環境変数が無い（原則1・2） ==="
if grep -rl 'CLAUDE_PROJECT_DIR' "$REPO_ROOT/.codex" 2>/dev/null; then
  assert_fail ".codex/配下にCLAUDE_PROJECT_DIR依存がある"
else
  assert_ok "CLAUDE_PROJECT_DIR依存なし"
fi

echo "=== scenario 3: .codex/hooks.json のcommandはgitベースのパス解決を使う（原則2） ==="
if [ -f "$HOOKS_JSON" ]; then
  NON_GIT_COMMANDS="$(jq -r '[.hooks[][]?.hooks[]?.command // empty] | map(select(test("git rev-parse --show-toplevel") | not)) | .[]' "$HOOKS_JSON" 2>/dev/null)"
  if [ -z "$NON_GIT_COMMANDS" ]; then
    assert_ok "全commandが git rev-parse --show-toplevel でパス解決している"
  else
    assert_fail "gitベース解決でないcommandがある" "$NON_GIT_COMMANDS"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 4: 共有deny系ガード(check-direct-ddl-execution.sh)がCodex側にも登録されている（共有面の固定） ==="
if [ -f "$HOOKS_JSON" ] && jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("check-direct-ddl-execution\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
  assert_ok "PreToolUseにcheck-direct-ddl-execution.shが登録されている"
  MATCHER="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | test("check-direct-ddl-execution\\.sh")) | .matcher' "$HOOKS_JSON")"
  if grep -q 'Bash' <<<"$MATCHER"; then
    assert_ok "matcherにBashが含まれる"
  else
    assert_fail "matcherにBashが含まれない" "matcher=$MATCHER"
  fi
  if grep -q 'execute_sql' <<<"$MATCHER"; then
    assert_ok "matcherにexecute_sqlが含まれる"
  else
    assert_fail "matcherにexecute_sqlが含まれない" "matcher=$MATCHER"
  fi
else
  assert_fail "check-direct-ddl-execution.shがCodex PreToolUseに未登録"
fi

echo "=== scenario 5: ask型ガード(check-skip-marker-write.sh)を直接登録せず、deny変換ラッパー経由で登録する（原則3: Codexはask未対応） ==="
if [ -f "$HOOKS_JSON" ]; then
  if jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("check-skip-marker-write\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    assert_fail "ask型のcheck-skip-marker-write.shが直接登録されている（Codexはask未対応のため素通りする）"
  else
    assert_ok "ask型ガードの直接登録なし"
  fi
  if jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | test("codex-skip-marker-deny\\.sh"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    assert_ok "deny変換ラッパー(codex-skip-marker-deny.sh)が登録されている"
  else
    assert_fail "deny変換ラッパーが未登録"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 6: Claude transcript形式依存のスクリプトをCodex側に登録しない（原則7） ==="
# WHY(2026-09-11 に実態ベースへ変えた): それまでは**スクリプト名の一覧**で判定しており、
#   `ai-check-suggest.sh` というパターンが `codex-ai-check-suggest.sh` にも部分一致していた。
#   後者は**まさに transcript を使わないために作った** Codex 専用版なのに違反と出た（誤検知）。
#   名前で判定する限り、同じことがまた起きる（C-011: 実態ではなく印だけを見る）。
#   いまは**スクリプトの中身で `transcript_path` を読んでいるか**を見る。
#   実体が見つからないものは「読めなかった」として違反側に倒す（fail-open にしない）。
if [ -f "$HOOKS_JSON" ]; then
  FOUND=""
  EXAMINED=0
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    # command からスクリプトのファイル名を取り出す
    name="$(printf '%s' "$cmd" | sed -n 's/.*\/\([A-Za-z0-9_.-]*\.sh\).*/\1/p')"
    [ -n "$name" ] || continue
    file="$REPO_ROOT/scripts/$name"
    if [ ! -f "$file" ]; then
      FOUND="${FOUND}${name}（実体が見つからず中身を確かめられない）
"
      continue
    fi
    EXAMINED=$((EXAMINED + 1))
    if grep -q 'transcript_path' "$file"; then
      FOUND="${FOUND}${name}（transcript_path を読んでいる）
"
    fi
  done <<EOF
$(jq -r '[.hooks[][]?.hooks[]?.command // empty] | .[]' "$HOOKS_JSON")
EOF
  if [ "$EXAMINED" -eq 0 ]; then
    assert_fail "Codex 側の hook スクリプトを 1 本も読めていない（走査が壊れている）"
  elif [ -z "$FOUND" ]; then
    assert_ok "transcript に依存する登録なし（中身を ${EXAMINED} 本確かめた）"
  else
    assert_fail "transcript に依存するスクリプトが登録されている" "$FOUND"
  fi
else
  assert_fail "hooks.jsonが無いため検証不能"
fi

echo "=== scenario 7: .claude/settings.json が .codex/ を参照しない（原則1の逆方向） ==="
if grep -q '\.codex/' "$CLAUDE_SETTINGS"; then
  assert_fail ".claude/settings.jsonが.codex/を参照している"
else
  assert_ok "逆方向の参照なし"
fi

echo "=== scenario 8: 共有ガード本体がツール非依存（scripts/配下の共有ロジックにCLAUDE_PROJECT_DIR依存が無い、原則2） ==="
SHARED_GUARDS="check-direct-ddl-execution.sh check-skip-marker-write.sh check-branch-pr-status.sh check-local-main-freshness.sh"
BAD=""
for g in $SHARED_GUARDS; do
  if grep -q 'CLAUDE_PROJECT_DIR' "$SCRIPT_DIR/$g" 2>/dev/null; then
    BAD="$BAD $g"
  fi
done
if [ -z "$BAD" ]; then
  assert_ok "共有ガード4本にCLAUDE_PROJECT_DIR依存なし"
else
  assert_fail "共有ガードにCLAUDE_PROJECT_DIR依存がある" "$BAD"
fi

echo "=== scenario 9: 登録された hook が、書いたそのパスにあり実行できる ==="
# WHY(2026-09-11): 「登録されているのに実体が無い」は診断器（scripts/lib/aidd-doctor.mjs）が
#      **既に両ツール分を見ている**（E-046）。ここが足すのは**その診断器が見ていない 2 つ**:
#        (a) `.codex/hooks.json` が書いた**そのパス**に実体があるか
#            （診断器は**名前**で scripts/ scripts/lib/ bin/ を順に探すので、
#            別の場所に同名のファイルがあれば「見つかった」と数える）
#        (b) **実行ビットが立っているか**
#      Codex はコマンドをそのまま起動するので、どちらが欠けても起動できない。
#      しかも Codex の hook は失敗しても黙って fail-open するので、誰も気づけない。
HASHER="$SCRIPT_DIR/lib/hook-registry-hash.mjs"
if [ ! -f "$HASHER" ] || ! command -v node >/dev/null 2>&1; then
  assert_fail "走査器（lib/hook-registry-hash.mjs）か node が無く、登録と実体を突き合わせられない"
else
  # WHY(C-044): `set -e` の下で素の代入をすると、走査が非ゼロを返した瞬間にこの検査自身が死ぬ
  if REG_LIST="$(node "$HASHER" --root "$REPO_ROOT" --codex-list 2>&1)"; then
    REG_COUNT="$(grep -c . <<<"$REG_LIST" || true)"
    if [ "$REG_COUNT" -ge 1 ]; then
      assert_ok "登録 ${REG_COUNT} 本を取り出せた（走査が空振りしていない）"
    else
      assert_fail "登録を 1 本も取り出せない（走査が壊れている疑い）" "$REG_LIST"
    fi
    BAD_ENTRY=""
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      if [ ! -f "$REPO_ROOT/$rel" ]; then
        BAD_ENTRY="$BAD_ENTRY
        実体なし: $rel"
      elif [ ! -x "$REPO_ROOT/$rel" ]; then
        BAD_ENTRY="$BAD_ENTRY
        実行できない: $rel"
      fi
    done <<<"$REG_LIST"
    if [ -z "$BAD_ENTRY" ]; then
      assert_ok "登録されたスクリプトはすべて実在し実行できる"
    else
      assert_fail "登録と実体が食い違う（Codex の hook は黙って fail-open する）" "$BAD_ENTRY"
    fi
  else
    assert_fail "登録の取り出しに失敗した" "$REG_LIST"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
