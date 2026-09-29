#!/bin/bash
# WHY: scripts/build-plugin.sh（プラグイン v1 の生成、issue #420 セット C）の回帰テスト。
#   1. 実態のリポジトリから生成でき、2 回生成しても一致する（決定性）
#   2. 生成物の workflow に名前空間の無い agentType / workflow( が残らない
#   3. hooks.json が settings.json の登録から作られ、${CLAUDE_PLUGIN_ROOT} を指す
#   4. コミット済みの dist/plugins/ が最新（--check）
#   5. RED: 共通側に禁止語を仕込むと生成が失敗する / 同梱されていない参照を検知する /
#      層の表に無い hook を検知する（fixture のミニリポジトリで自己検証）
#
# 実行: bash scripts/build-plugin.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD="$SCRIPT_DIR/lib/build-plugin.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実態から生成できる・2 回の生成が一致する（決定性） ==="
node "$BUILD" --out "$WORK/a" >/dev/null
node "$BUILD" --out "$WORK/b" >/dev/null
if diff -r "$WORK/a" "$WORK/b" >/dev/null; then ok "2 回の生成が一致"; else ng "生成が決定的でない" "$(diff -r "$WORK/a" "$WORK/b" | head -5)"; fi
[ -f "$WORK/a/aidd-core/.claude-plugin/plugin.json" ] && ok "aidd-core の manifest がある" || ng "aidd-core の manifest が無い"
[ -f "$WORK/a/aidd-vkumai/.claude-plugin/plugin.json" ] && ok "aidd-vkumai の manifest がある" || ng "aidd-vkumai の manifest が無い"
[ -f "$WORK/a/aidd-codex/hooks/hooks.json" ] && ok "aidd-codex の hooks.json がある" || ng "aidd-codex の hooks.json が無い"
if jq -e '.dependencies[0].name == "aidd-core"' "$WORK/a/aidd-vkumai/.claude-plugin/plugin.json" >/dev/null; then ok "aidd-vkumai は aidd-core に依存"; else ng "依存が書かれていない"; fi

echo "=== scenario 2: 生成物の workflow は名前空間付きで、LOCAL 設定は空 ==="
BARE="$(grep -h -o -E "agentType: '[^':]+'" "$WORK"/a/*/workflows/*.js || true)"
[ -z "$BARE" ] && ok "裸の agentType が無い" || ng "裸の agentType が残る" "$BARE"
if grep -q "agentType: 'aidd-vkumai:sweep-ui'" "$WORK/a/aidd-vkumai/workflows/aidd-phase1.js"; then ok "sweep-ui が aidd-vkumai:sweep-ui になる"; else ng "agentType の書き換え無し"; fi
if grep -q "workflow('aidd-vkumai:aidd-phase1'" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "workflow() も修飾される"; else ng "workflow() の書き換え無し"; fi
if grep -q "const LOCAL_RISK_CONFIG = {}" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "LOCAL_RISK_CONFIG が空になる"; else ng "LOCAL 設定が残っている"; fi
if grep -q "facility" "$WORK/a/aidd-vkumai/workflows/aidd-phase1-router.js"; then ok "アダプター側の説明文の固有語は残してよい（禁止語検査は共通側のみ）"; fi

echo "=== scenario 3: hooks.json は settings.json から作られ、\${CLAUDE_PLUGIN_ROOT} を指す ==="
CORE_HOOKS="$WORK/a/aidd-core/hooks/hooks.json"
jq -e '.hooks.SessionStart' "$CORE_HOOKS" >/dev/null && ok "SessionStart がある" || ng "SessionStart が無い"
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'CLAUDE_PROJECT_DIR'; then ng "CLAUDE_PROJECT_DIR が残っている"; else ok "パスは CLAUDE_PLUGIN_ROOT に置き換わる"; fi
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'check-branch-tool-ownership.sh claude'; then ok "引数付き hook も引数を保つ"; else ng "引数が落ちた"; fi
if jq -r '.. | .command? // empty' "$CORE_HOOKS" | grep -q 'check-direct-ddl-execution'; then ng "vkumai 専用 hook が core に混入"; else ok "vkumai 専用 hook は core に入らない"; fi
if jq -r '.. | .command? // empty' "$WORK/a/aidd-vkumai/hooks/hooks.json" | grep -q 'check-direct-ddl-execution'; then ok "vkumai 専用 hook はアダプター側にある"; else ng "アダプター側に無い"; fi
for f in $(jq -r '.. | .command? // empty' "$CORE_HOOKS" | sed -E 's#^"\$\{CLAUDE_PLUGIN_ROOT\}"/##; s# .*$##'); do
  [ -f "$WORK/a/aidd-core/$f" ] || ng "hooks.json が指すスクリプトが同梱されていない: $f"
done
ok "hooks.json が指すスクリプトはすべて同梱されている（欠落があれば上に NG）"
[ -x "$WORK/a/aidd-core/bin/log-agent-progress.sh" ] && ok "bin/ に進捗記録スクリプトがあり実行可能" || ng "bin/ が無い"
if grep -q "scripts/log-agent-progress.sh" "$WORK/a/aidd-core/agents/reviewer.md"; then ng "agent 本文の scripts/ 参照が残る"; else ok "agent 本文の scripts/<bin> は裸の名前に書き換わる"; fi

echo "=== scenario 3b: Codex hook は project 設定から4本だけ生成される ==="
CODEX_DIR="$WORK/a/aidd-codex"
CODEX_HOOKS="$CODEX_DIR/hooks/hooks.json"
if [ -f "$CODEX_HOOKS" ]; then
  CODEX_COMMANDS="$(jq -r '.. | .command? // empty' "$CODEX_HOOKS")"
  [ "$(printf '%s\n' "$CODEX_COMMANDS" | grep -c .)" -eq 4 ] && ok "Codex hook は4本" || ng "Codex hook が4本でない" "$CODEX_COMMANDS"
  for name in check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh codex-skip-marker-deny.sh; do
    grep -qF '"${PLUGIN_ROOT}"/scripts/'"$name" <<<"$CODEX_COMMANDS" && ok "$name のパスを変換" || ng "$name のパスが変換されていない"
  done
  grep -qF 'check-branch-tool-ownership.sh codex' <<<"$CODEX_COMMANDS" && ok "Codex 引数を維持" || ng "Codex 引数が落ちた"
  if grep -qE 'check-direct-ddl-execution|codex-dependency-change|codex-ai-check' <<<"$CODEX_COMMANDS"; then ng "固有 hook が混入"; else ok "固有 hook は出力しない"; fi
  if grep -qF '$(git rev-parse --show-toplevel)' <<<"$CODEX_COMMANDS"; then ng "project root 形式が残った"; else ok "project root 形式を残さない"; fi
  [ -f "$CODEX_DIR/.aidd-manifest.json" ] && ok "Codex 配布物に同一性 manifest がある" || ng "Codex 配布物の同一性 manifest が無い"
  [ "$(find "$CODEX_DIR/scripts" -type f | wc -l | tr -d ' ')" -eq 7 ] && ok "Codex に正本6ファイルと doctor 検査を同梱" || ng "Codex の scripts/ が7ファイルでない"
  [ ! -e "$CODEX_DIR/plugin.json" ] && ok "Codex 配布物のルートに plugin.json を出さない" || ng "ルート plugin.json が残っている"
  CODEX_MANIFEST="$CODEX_DIR/.codex-plugin/plugin.json"
  LAYOUT_CODEX_VERSION="$(jq -r '.codexPlugins["aidd-codex"].version' "$REPO_ROOT/scripts/lib/plugin-layout.json")"
  if [ -f "$CODEX_MANIFEST" ] && jq -e --arg v "$LAYOUT_CODEX_VERSION" 'keys == ["description", "hooks", "name", "version"] and .name == "aidd-codex" and .version == $v and .description == "中心リポジトリから生成した AIDD の Codex 用 hook と環境診断" and .hooks == "./hooks/hooks.json"' "$CODEX_MANIFEST" >/dev/null; then
    ok "実測で動いた legacy manifest を生成"
  else
    ng "legacy manifest が実測済みの形と違う"
  fi
  [ -f "$CODEX_DIR/skills/aidd-doctor/SKILL.md" ] && ok "doctor スキルを生成" || ng "doctor スキルが無い"
  for name in KNOWN-LIMITS.md COMPATIBILITY.md CHANGELOG.md; do
    cmp -s "$CODEX_DIR/$name" "$REPO_ROOT/docs/plugin/codex/$name" && ok "$name を正本から生成" || ng "$name が正本と違う"
  done
  for name in check-branch-pr-status.sh check-branch-tool-ownership.sh check-local-main-freshness.sh check-skip-marker-write.sh; do
    cmp -s "$CODEX_DIR/scripts/$name" "$WORK/a/aidd-core/scripts/$name" && ok "$name は core と同一" || ng "$name が core と異なる"
  done
  [ -x "$CODEX_DIR/scripts/codex-skip-marker-deny.sh" ] && ok "Codex ラッパーが実行可能" || ng "Codex ラッパーが実行不能"
  for name in check-branch-pr-status check-branch-tool-ownership check-local-main-freshness check-skip-marker-write codex-skip-marker-deny; do
    if SCRIPT_UNDER_TEST="$CODEX_DIR/scripts/$name.sh" bash "$REPO_ROOT/scripts/$name.test.sh" >"$WORK/$name-plugin-test.log" 2>&1; then
      ok "$name の既存テストがプラグイン内の本体で通る"
    else
      ng "$name の既存テストがプラグイン内の本体で失敗" "$(tail -5 "$WORK/$name-plugin-test.log")"
    fi
  done
  CONSUMER="$WORK/codex-consumer"
  git -C "$WORK" init -q -b main "$CONSUMER"
  git -C "$CONSUMER" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init
  git -C "$CONSUMER" checkout -q -b claude/consumer-check
  CONTEXT_OUTPUT="$(cd "$CONSUMER" && PLUGIN_ROOT="$CODEX_DIR" bash "$CODEX_DIR/scripts/check-branch-tool-ownership.sh" codex)"
  grep -qF 'claude/consumer-check' <<<"$CONTEXT_OUTPUT" && ok "作業対象のブランチを読む（PLUGIN_ROOT を Git root と誤認しない）" || ng "作業対象の Git root を読めない"
fi

echo "=== scenario 3c: vkumai 固有の Codex hook は aidd-codex-vkumai に4本だけ生成される ==="
# WHY(2026-09-28): 仕様書 §3 で初版から外した 4 本を、共通の aidd-codex に混ぜず別プラグインで配る
#      （Claude 側の aidd-core / aidd-vkumai と同じ分け方）。共通側の hooks.json が不変であること
#      （＝導入済み環境の再信頼が不要なこと）も対で確かめる。
CV_DIR="$WORK/a/aidd-codex-vkumai"
CV_HOOKS="$CV_DIR/hooks/hooks.json"
if [ ! -f "$CV_HOOKS" ]; then
  ng "aidd-codex-vkumai の hooks.json が無い"
else
  CV_COMMANDS="$(jq -r '.. | .command? // empty' "$CV_HOOKS")"
  [ "$(printf '%s\n' "$CV_COMMANDS" | grep -c .)" -eq 4 ] && ok "vkumai 固有の Codex hook は4本" || ng "4本でない" "$CV_COMMANDS"
  for name in check-direct-ddl-execution.sh codex-dependency-change-deny.sh codex-ai-check-track.sh codex-ai-check-suggest.sh; do
    grep -qF '"${PLUGIN_ROOT}"/scripts/'"$name" <<<"$CV_COMMANDS" && ok "$name のパスを変換" || ng "$name のパスが変換されていない"
  done
  if grep -qE 'check-branch-|codex-skip-marker' <<<"$CV_COMMANDS"; then ng "共通 hook が固有側に混入"; else ok "共通 hook は固有側に出力しない"; fi
  jq -e '.hooks.PreToolUse[0].matcher == "Bash|mcp__.*execute_sql"' "$CV_HOOKS" >/dev/null && ok "DDL hook の matcher（MCP execute_sql 含む）を維持" || ng "DDL hook の matcher が変わった"
  jq -e '.hooks.Stop[0].hooks[0].statusMessage | length > 0' "$CV_HOOKS" >/dev/null && ok "Stop hook の statusMessage を維持" || ng "statusMessage が落ちた"
  [ -f "$CV_DIR/.aidd-manifest.json" ] && ok "同一性 manifest がある" || ng "同一性 manifest が無い"
  [ ! -e "$CV_DIR/plugin.json" ] && ok "ルートに plugin.json を出さない" || ng "ルート plugin.json が残っている"
  CV_LAYOUT_VERSION="$(jq -r '.codexPlugins["aidd-codex-vkumai"].version' "$REPO_ROOT/scripts/lib/plugin-layout.json")"
  jq -e --arg v "$CV_LAYOUT_VERSION" 'keys == ["description", "hooks", "name", "version"] and .name == "aidd-codex-vkumai" and .version == $v and .hooks == "./hooks/hooks.json"' "$CV_DIR/.codex-plugin/plugin.json" >/dev/null && ok "manifest は aidd-codex と同じ形式" || ng "manifest の形が違う"
  for name in KNOWN-LIMITS.md COMPATIBILITY.md CHANGELOG.md; do
    cmp -s "$CV_DIR/$name" "$REPO_ROOT/docs/plugin/codex-vkumai/$name" && ok "$name を正本から生成" || ng "$name が正本と違う"
  done
  for name in check-direct-ddl-execution.sh check-dependency-change.sh; do
    cmp -s "$CV_DIR/scripts/$name" "$WORK/a/aidd-vkumai/scripts/$name" && ok "$name は aidd-vkumai と同一" || ng "$name が aidd-vkumai と異なる"
  done
  [ ! -e "$CV_DIR/skills" ] && ok "固有側にスキルは無い（doctor は aidd-codex 側）" || ng "固有側に skills/ がある"
  # 同梱した判定本体とラッパーに対して既存テストを回す（scenario 3b と同型）
  if bash "$CV_DIR/scripts/check-dependency-change.test.sh" >"$WORK/cv-dep-test.log" 2>&1; then
    ok "check-dependency-change.test.sh がプラグイン内の本体とラッパーで通る"
  else
    ng "check-dependency-change.test.sh がプラグイン内で失敗" "$(tail -5 "$WORK/cv-dep-test.log")"
  fi
  if SCRIPT_UNDER_TEST="$CV_DIR/scripts/check-direct-ddl-execution.sh" bash "$REPO_ROOT/scripts/check-direct-ddl-execution.test.sh" >"$WORK/cv-ddl-test.log" 2>&1; then
    ok "check-direct-ddl-execution.test.sh がプラグイン内の本体で通る"
  else
    ng "check-direct-ddl-execution.test.sh がプラグイン内で失敗" "$(tail -5 "$WORK/cv-ddl-test.log")"
  fi
  # 共通側の hooks.json はこの追加で変わらない（変わると導入済み環境で再信頼が要る。RELEASE.md §4.3）
  cmp -s "$WORK/a/aidd-codex/hooks/hooks.json" "$REPO_ROOT/dist/plugins/aidd-codex/hooks/hooks.json" && ok "aidd-codex の hooks.json はコミット済みと同一（再信頼不要）" || ng "aidd-codex の hooks.json が変わった（導入先で再信頼が要る。CHANGELOG に書く）"
fi

echo "=== scenario 3d: Codex 配布物の警告文が、導入先に無い文書を指さない ==="
# WHY(2026-09-29): 警告文は「docs/agents/common.md を参照」のように vkumai の文書を案内していたが、
#      プラグインを入れた別のリポジトリにその文書は無い。AI が探しに行って見つけられず時間を使う
#      （docs/specs/codex-hook-parity/06-message-pointers.md）。利用者にも AI にも見えない
#      コメント行は対象外。テスト（*.test.sh）も対象外。
scan_doc_pointers() { # $1=プラグインのディレクトリ。「ファイル名:行番号:本文」で出す
  local f
  for f in "$1"/scripts/*.sh; do
    case "$f" in *.test.sh) continue ;; esac
    [ -f "$f" ] || continue
    { grep -n -E 'docs/(agents|superpowers)/' "$f" 2>/dev/null || true; } \
      | { grep -v -E '^[0-9]+:[[:space:]]*#' || true; } \
      | sed "s|^|$(basename "$f"):|"
  done
  return 0
}
for dir in "$WORK/a/aidd-codex" "$WORK/a/aidd-codex-vkumai"; do
  name="$(basename "$dir")"
  SCANNED="$(find "$dir/scripts" -name '*.sh' ! -name '*.test.sh' -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$SCANNED" -gt 0 ] && ok "$name: ${SCANNED} 本を走査した（空振りしていない）" || ng "$name: 走査対象が 0 本"
  POINTERS="$(scan_doc_pointers "$dir")"
  if [ -z "$POINTERS" ]; then ok "$name: 警告文に vkumai の文書への案内が無い"; else ng "$name: 警告文が導入先に無い文書を指している" "$POINTERS"; fi
done
# 壊して落ちることを確かめる（案内を 1 つ戻すと見つける。コメントとテストは見ない）
POINTER_FIXTURE="$WORK/pointer-fixture"
mkdir -p "$POINTER_FIXTURE/scripts"
printf '%s\n' '# コメントの docs/agents/common.md は対象外' 'MSG="…してください（docs/agents/common.md「ブランチ運用ルール」参照）。"' > "$POINTER_FIXTURE/scripts/with-pointer.sh"
printf '%s\n' '  # 字下げしたコメントの docs/superpowers/specs/x.md も対象外' 'MSG="…してください。"' > "$POINTER_FIXTURE/scripts/clean.sh"
printf '%s\n' 'MSG="docs/agents/common.md"' > "$POINTER_FIXTURE/scripts/only.test.sh"
RED_POINTERS="$(scan_doc_pointers "$POINTER_FIXTURE")"
grep -qF 'with-pointer.sh:2:' <<<"$RED_POINTERS" && ok "案内を戻すと行番号つきで見つける" || ng "案内を戻しても見つけられない" "$RED_POINTERS"
if grep -qF 'with-pointer.sh:1:' <<<"$RED_POINTERS"; then ng "コメント行まで対象にしている"; else ok "コメント行は対象外"; fi
if grep -qE 'clean\.sh|only\.test\.sh' <<<"$RED_POINTERS"; then ng "字下げしたコメントかテストを対象にしている" "$RED_POINTERS"; else ok "字下げしたコメントとテストは対象外"; fi

echo "=== scenario 4: コミット済みの dist/plugins/ が最新（--check） ==="
if node "$BUILD" --check >/dev/null 2>"$WORK/check.err"; then ok "dist/plugins/ は最新"; else ng "dist/plugins/ が古い（bash scripts/build-plugin.sh で更新）" "$(head -5 "$WORK/check.err")"; fi

echo "=== scenario 4b: 7 項目のファイル・スキーマ・ひな形が生成物にある（SPEC Part 1 の 3.） ==="
for p in aidd-core aidd-vkumai; do
  for f in COMPATIBILITY.md CHANGELOG.md KNOWN-LIMITS.md MIGRATION.md BREAKING.md; do
    [ -f "$WORK/a/$p/$f" ] || ng "$p に $f が無い"
  done
  [ -n "$(ls "$WORK/a/$p/evidence" 2>/dev/null)" ] || ng "$p に evidence/ が無い"
done
ok "両プラグインに 5 文書と evidence/ がある（欠落があれば上に NG）"
[ -f "$WORK/a/aidd-core/schema/aidd-config.schema.json" ] && ok "設定スキーマが aidd-core/schema/ にある" || ng "スキーマが無い"
[ -f "$WORK/a/aidd-core/templates/consumer/aidd.config.json" ] && ok "導入先ひな形が aidd-core/templates/ にある" || ng "ひな形が無い"
# WHY(2026-09-12): ひな形の README は**表に 4 行しか無いのに実ファイルは 8 個**だった。
#      説明の無いファイルを渡された導入先は、置き場も役割も分からない。逆に、表にあるのに
#      実体が無い行（`.claude/rules/`）もあった。**どちらの向きもここまで誰も見ていなかった**
#      （既存の門は agent / skill / workflow しか見ず、ひな形は aidd.config.json の存在 1 件だけ）。
#      表と実体を両方向で突き合わせる（C-011: 宣言の検査が「実在するか」しか見ていない、の逆側）。
TPL_DIR="$WORK/a/aidd-core/templates/consumer"
TPL_README="$TPL_DIR/README.md"
if [ ! -f "$TPL_README" ]; then
  ng "ひな形に README が無い（渡されたファイルの役割を誰も説明できない）"
else
  TPL_MISSING_DOC=""
  for f in "$TPL_DIR"/*; do
    b="$(basename "$f")"
    [ "$b" = "README.md" ] && continue
    grep -qF -- "\`$b\`" "$TPL_README" || TPL_MISSING_DOC="${TPL_MISSING_DOC}${b} "
  done
  TPL_GHOST=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -e "$TPL_DIR/$name" ] || TPL_GHOST="${TPL_GHOST}${name} "
  done <<< "$(grep -o -E '^\| `[^`]+`' "$TPL_README" | tr -d '|` ' || true)"
  if [ -z "$TPL_MISSING_DOC" ] && [ -z "$TPL_GHOST" ]; then
    ok "ひな形の README が実ファイルを過不足なく説明している"
  else
    [ -n "$TPL_MISSING_DOC" ] && ng "README が説明していないひな形ファイルがある: $TPL_MISSING_DOC"
    [ -n "$TPL_GHOST" ] && ng "README の表にあるのに実体が無い: $TPL_GHOST"
  fi
fi
# COMPATIBILITY.md の版は docs/agents/upstream-docs-review.md「最後に確認した版」（正本）と一致する
REVIEWED="$(grep -o -E 'Claude Code \| [0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT/docs/agents/upstream-docs-review.md" | head -n1 | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' || true)"
if [ -n "$REVIEWED" ] && grep -q "$REVIEWED" "$WORK/a/aidd-core/COMPATIBILITY.md"; then ok "COMPATIBILITY.md が docs 確認版 $REVIEWED を含む"; else ng "COMPATIBILITY.md の版が upstream-docs-review と食い違う（reviewed=${REVIEWED}）"; fi

echo "=== scenario 4c: --marketplace で出力先の親に marketplace.json と README を書く（配布形態 (a)） ==="
node "$BUILD" --marketplace --out "$WORK/mp/plugins" >/dev/null
[ -f "$WORK/mp/.claude-plugin/marketplace.json" ] && ok "marketplace.json がある" || ng "marketplace.json が無い"
if jq -e '.metadata.pluginRoot == "./plugins" and (.plugins | length) == 2' "$WORK/mp/.claude-plugin/marketplace.json" >/dev/null; then ok "pluginRoot と 2 プラグインがある"; else ng "marketplace.json の内容"; fi
# WHY(2026-09-28): 版の正本は plugin.json。エントリにも書くと公式が「両方に書くな」とする形になる（RELEASE.md §0）
if jq -e '[.plugins[] | has("version")] | any | not' "$WORK/mp/.claude-plugin/marketplace.json" >/dev/null; then ok "エントリに version を書かない（正本は plugin.json）"; else ng "エントリに version が残っている"; fi
[ -f "$WORK/mp/README.md" ] && ok "README がある" || ng "README が無い"
# Codex 用カタログ: Claude 用とは別ファイルで、aidd-codex を実測済みの local + 相対 path で指す
CODEX_CATALOG="$WORK/mp/.agents/plugins/marketplace.json"
if [ -f "$CODEX_CATALOG" ] && jq -e '.name == "aidd-plugins" and (.plugins | length) == 2 and .plugins[0].name == "aidd-codex" and .plugins[0].source.source == "local" and .plugins[0].source.path == "./plugins/aidd-codex" and .plugins[0].policy.installation == "AVAILABLE" and (.plugins[0].category | length) > 0 and .plugins[1].name == "aidd-codex-vkumai" and .plugins[1].source.path == "./plugins/aidd-codex-vkumai"' "$CODEX_CATALOG" >/dev/null; then ok "Codex 用カタログ .agents/plugins/marketplace.json が aidd-codex と aidd-codex-vkumai を指す"; else ng "Codex 用カタログが無いか内容が違う"; fi
[ -d "$WORK/mp/plugins/aidd-codex" ] && ok "marketplace 出力に aidd-codex の実体がある" || ng "aidd-codex が marketplace 出力に無い"
[ -d "$WORK/mp/plugins/aidd-codex-vkumai" ] && ok "marketplace 出力に aidd-codex-vkumai の実体がある" || ng "aidd-codex-vkumai が marketplace 出力に無い"
grep -q 'codex plugin add aidd-codex@aidd-plugins' "$WORK/mp/README.md" && ok "README に Codex の導入手順がある" || ng "README に Codex の導入手順が無い"
grep -q 'codex plugin add aidd-codex-vkumai@aidd-plugins' "$WORK/mp/README.md" && ok "README に aidd-codex-vkumai の導入手順がある" || ng "README に aidd-codex-vkumai の導入手順が無い"
# WHY(2026-09-28 実測): 依存側は update で自動に上がらないので、README は全プラグイン分の update を並べる
for p in aidd-core aidd-vkumai; do
  grep -qF "claude plugin update $p@aidd-plugins" "$WORK/mp/README.md" && ok "README に $p の更新手順がある" || ng "README に $p の更新手順が無い"
done
if jq -e '.author.name and .metadata.generatedBy' "$WORK/mp/plugins/aidd-core/.claude-plugin/plugin.json" >/dev/null; then ok "plugin.json に author と metadata.generatedBy がある（validate の警告なし）"; else ng "plugin.json の author / metadata"; fi
if jq -e 'has("hooks") | not' "$WORK/mp/plugins/aidd-core/.claude-plugin/plugin.json" >/dev/null; then ok "plugin.json に hooks を書かない（自動読み込みと重複するため）"; else ng "plugin.json に hooks が残っている"; fi

echo "=== scenario 5: RED 方向（fixture のミニリポジトリ） ==="
FX="$WORK/fixture"
mkdir -p "$FX/.claude/agents" "$FX/.claude/workflows" "$FX/scripts/lib"
cat > "$FX/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-a.sh","timeout":5}]}]}}
EOF
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/helper.sh"\necho ok\n' > "$FX/scripts/hook-a.sh"
printf 'helper() { :; }\n' > "$FX/scripts/lib/helper.sh"
printf -- '---\nname: agent-a\n---\n本文\n' > "$FX/.claude/agents/agent-a.md"
printf "export const meta = { name: 'flow-a' }\nawait agent('x', { agentType: 'agent-a' })\n" > "$FX/.claude/workflows/flow-a.js"
cat > "$FX/layout.json" <<'EOF'
{
  "plugins": {"core": {"version": "0.0.1", "description": "d", "dependencies": [], "forbiddenWords": true}},
  "forbiddenWords": ["forbiddenword"],
  "agents": {"agent-a": "core"},
  "skills": {},
  "workflows": {"flow-a": "core"},
  "hookScripts": {"hook-a.sh": "core"},
  "supportScripts": {"lib/helper.sh": "core"},
  "bin": {},
  "allowUnresolvedReferences": {}
}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-ok" >/dev/null 2>&1; then ok "正しい fixture は生成できる"; else ng "正しい fixture で失敗"; fi
grep -q "agentType: 'core:agent-a'" "$WORK/fx-ok/core/workflows/flow-a.js" && ok "fixture でも名前空間が付く" || ng "fixture の名前空間"

printf -- '---\nname: agent-a\n---\n本文 forbiddenword\n' > "$FX/.claude/agents/agent-a.md"
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red1" >/dev/null 2>"$WORK/red1.err"; then ng "禁止語を検知できない"; else grep -q '禁止語' "$WORK/red1.err" && ok "禁止語で失敗する" || ng "失敗理由が禁止語でない" "$(cat "$WORK/red1.err")"; fi
[ ! -d "$WORK/fx-red1" ] && ok "失敗時は出力を書かない" || ng "失敗時に出力が書かれた"
printf -- '---\nname: agent-a\n---\n本文\n' > "$FX/.claude/agents/agent-a.md"

printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/missing.sh"\n' > "$FX/scripts/hook-a.sh"
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red2" >/dev/null 2>"$WORK/red2.err"; then ng "同梱漏れを検知できない"; else grep -q '同梱されていない' "$WORK/red2.err" && ok "同梱されていない参照で失敗する" || ng "失敗理由が同梱漏れでない" "$(cat "$WORK/red2.err")"; fi
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/helper.sh"\necho ok\n' > "$FX/scripts/hook-a.sh"

cat > "$FX/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-a.sh","timeout":5},{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-b.sh","timeout":5}]}]}}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout.json" --out "$WORK/fx-red3" >/dev/null 2>"$WORK/red3.err"; then ng "層の表に無い hook を検知できない"; else grep -q 'hookScripts に無い' "$WORK/red3.err" && ok "層の表に無い hook で失敗する" || ng "失敗理由が違う" "$(cat "$WORK/red3.err")"; fi
cat > "$FX/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/hook-a.sh","timeout":5}]}]}}
EOF

echo "=== scenario 6: 逃がし口（allowUnresolvedReferences）の衛生 ==="
# WHY(2026-09-11): **死んだ免除は、同じ参照が将来また入ったときに黙って通す。** しかも理由は
#      別の文脈で書かれたものなので、読んだ人は納得してしまう。実測すると 51 件中 15 件が
#      一度も当たっていなかった。逃がし口は放っておくと腐るので、当たっているかと件数を見る。
mk_layout() { # $1=allowUnresolvedReferences の中身 $2=max 行（空なら書かない）
  {
    printf '{\n'
    printf '  "plugins": {"core": {"version": "0.0.1", "description": "d", "dependencies": [], "forbiddenWords": true}},\n'
    printf '  "forbiddenWords": ["forbiddenword"],\n'
    printf '  "agents": {"agent-a": "core"},\n'
    printf '  "skills": {},\n'
    printf '  "workflows": {"flow-a": "core"},\n'
    printf '  "hookScripts": {"hook-a.sh": "core"},\n'
    printf '  "supportScripts": {"lib/helper.sh": "core"},\n'
    printf '  "bin": {},\n'
    [ -n "${2:-}" ] && printf '  "allowUnresolvedReferencesMax": %s,\n' "$2"
    printf '  "allowUnresolvedReferences": %s\n' "$1"
    printf '}\n'
  } > "$FX/layout2.json"
}

# 免除が 0 件なら上限を書かせない（対を置く。使っていない導入先で毎回赤くしない）
mk_layout '{}' ''
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow0" >/dev/null 2>"$WORK/allow0.err"; then ok "逃がし口が 0 件なら上限は要らない"; else ng "逃がし口 0 件で落ちた" "$(cat "$WORK/allow0.err")"; fi

# 一度も当たらない免除は落とす
mk_layout '{"scripts/never-referenced.sh": "どこからも参照されていない"}' '5'
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow1" >/dev/null 2>"$WORK/allow1.err"; then ng "死んだ免除を検知できない"; else grep -q '一度も当たっていない' "$WORK/allow1.err" && ok "一度も当たらない免除を検知" || ng "失敗理由が違う" "$(cat "$WORK/allow1.err")"; fi

# 実際に当たる免除は誤検知しない（対を置く。C-021）
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/missing.sh"\n' > "$FX/scripts/hook-a.sh"
mk_layout '{"scripts/lib/missing.sh": "導入先が持つので同梱しない"}' '5'
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow2" >/dev/null 2>"$WORK/allow2.err"; then ok "当たっている免除は通る"; else ng "当たっている免除で落ちた" "$(cat "$WORK/allow2.err")"; fi

# 理由が空の免除は落とす
mk_layout '{"scripts/lib/missing.sh": "   "}' '5'
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow3" >/dev/null 2>"$WORK/allow3.err"; then ng "理由が空の免除を検知できない"; else grep -q '理由が空' "$WORK/allow3.err" && ok "理由が空の免除を検知" || ng "失敗理由が違う" "$(cat "$WORK/allow3.err")"; fi

# 上限を書き忘れたら落とす（免除があるのに見張りが無い状態を許さない）
mk_layout '{"scripts/lib/missing.sh": "導入先が持つので同梱しない"}' ''
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow4" >/dev/null 2>"$WORK/allow4.err"; then ng "上限の書き忘れを検知できない"; else grep -q 'allowUnresolvedReferencesMax が層の表に無い' "$WORK/allow4.err" && ok "上限の書き忘れを検知" || ng "失敗理由が違う" "$(cat "$WORK/allow4.err")"; fi

# 上限を超えたら落とす
mk_layout '{"scripts/lib/missing.sh": "導入先が持つので同梱しない"}' '0'
if node "$BUILD" --source "$FX" --layout "$FX/layout2.json" --out "$WORK/fx-allow5" >/dev/null 2>"$WORK/allow5.err"; then ng "上限超過を検知できない"; else grep -q '上限 0 を超えた' "$WORK/allow5.err" && ok "上限超過を検知" || ng "失敗理由が違う" "$(cat "$WORK/allow5.err")"; fi
printf '#!/usr/bin/env bash\nsource "$SCRIPT_DIR/lib/helper.sh"\necho ok\n' > "$FX/scripts/hook-a.sh"

echo "=== scenario 7: Codex 用 command 形式の検査（RED 方向） ==="
mkdir -p "$FX/.codex"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FX/scripts/codex-hook.sh"
node - "$FX/layout.json" "$FX/layout-codex.json" <<'NODE'
const fs = require('node:fs')
const layout = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
layout.codexHookScripts = { 'codex-hook.sh': 'aidd-codex' }
layout.codexPlugins = { 'aidd-codex': { version: '0.0.1', description: 'd', manifestPath: '.codex-plugin/plugin.json', sourceDir: 'docs/plugin/codex', releaseDocs: [], skills: [] } }
fs.writeFileSync(process.argv[3], JSON.stringify(layout))
NODE
cat > "$FX/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"\"$(git rev-parse --show-toplevel)\"/scripts/codex-hook.sh codex"}]}]}}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout-codex.json" --out "$WORK/fx-codex-ok" >/dev/null 2>"$WORK/codex-ok.err"; then
  if jq -e '.hooks.SessionStart[0].hooks[0].command == "\"${PLUGIN_ROOT}\"/scripts/codex-hook.sh codex"' "$WORK/fx-codex-ok/aidd-codex/hooks/hooks.json" >/dev/null; then ok "Codex fixture の変換と引数を維持"; else ng "Codex fixture の変換結果が違う"; fi
else
  ng "正しい Codex fixture で失敗" "$(cat "$WORK/codex-ok.err")"
fi
cat > "$FX/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/codex-hook.sh"}]}]}}
EOF
if node "$BUILD" --source "$FX" --layout "$FX/layout-codex.json" --out "$WORK/fx-codex-bad" >/dev/null 2>"$WORK/codex-bad.err"; then
  ng "Codex の想定外 command を拒否できない"
else
  grep -q '想定外の command 形式' "$WORK/codex-bad.err" && ok "Codex の想定外 command を拒否" || ng "拒否理由が違う" "$(cat "$WORK/codex-bad.err")"
  [ ! -d "$WORK/fx-codex-bad" ] && ok "不正な入力から配布物を書かない" || ng "不正な入力で配布物を書いた"
fi

echo "=== scenario 8: 版の整合（RED 方向。RELEASE.md §1: 全プラグインは同じ版を同時に上げる） ==="
# WHY(2026-09-28): 版は層の表の 3 箇所と依存範囲に散っている。1 箇所だけ上げて配ると導入先の
#      依存解決が失敗する。揃っていない層の表では生成しないことを、壊して確かめる。
mk_versions() { # $1=core 版 $2=addon 版 $3=addon→core 依存範囲 $4=Codex プラグイン版（空なら書かない）
  node - "$FX/layout-codex.json" "$FX/layout-ver.json" "$1" "$2" "$3" "$4" <<'NODE'
const fs = require('node:fs')
const [src, dst, coreV, addonV, depRange, codexV] = process.argv.slice(2)
const layout = JSON.parse(fs.readFileSync(src, 'utf8'))
layout.plugins.core.version = coreV
layout.plugins.addon = { version: addonV, description: 'd', dependencies: [{ name: 'core', version: depRange }], forbiddenWords: false }
if (codexV) layout.codexPlugins['aidd-codex'].version = codexV
fs.writeFileSync(dst, JSON.stringify(layout))
NODE
}
cat > "$FX/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"\"$(git rev-parse --show-toplevel)\"/scripts/codex-hook.sh codex"}]}]}}
EOF
mk_versions 0.2.0 0.2.0 '^0.2.0' 0.2.0
if node "$BUILD" --source "$FX" --layout "$FX/layout-ver.json" --out "$WORK/fx-ver-ok" >/dev/null 2>"$WORK/ver-ok.err"; then ok "揃った版は通る"; else ng "揃った版で落ちた" "$(cat "$WORK/ver-ok.err")"; fi
mk_versions 0.2.0 0.2.0 '^0.2.0' 0.1.0
if node "$BUILD" --source "$FX" --layout "$FX/layout-ver.json" --out "$WORK/fx-ver-red1" >/dev/null 2>"$WORK/ver-red1.err"; then ng "Codex プラグインだけ古い版を検知できない"; else grep -q '版が揃っていない' "$WORK/ver-red1.err" && ok "Codex プラグインだけ古い版で失敗する" || ng "失敗理由が違う" "$(cat "$WORK/ver-red1.err")"; fi
mk_versions 0.2.0 0.1.0 '^0.1.0' 0.2.0
if node "$BUILD" --source "$FX" --layout "$FX/layout-ver.json" --out "$WORK/fx-ver-red2" >/dev/null 2>"$WORK/ver-red2.err"; then ng "core だけ上げた版を検知できない"; else grep -q '版が揃っていない' "$WORK/ver-red2.err" && ok "core だけ上げた版で失敗する" || ng "失敗理由が違う" "$(cat "$WORK/ver-red2.err")"; fi
mk_versions 0.2.0 0.2.0 '^0.1.0' 0.2.0
if node "$BUILD" --source "$FX" --layout "$FX/layout-ver.json" --out "$WORK/fx-ver-red3" >/dev/null 2>"$WORK/ver-red3.err"; then ng "依存範囲の更新漏れを検知できない"; else grep -q '依存範囲' "$WORK/ver-red3.err" && ok "依存範囲 ^0.1.0 が 0.2.0 を含まないので失敗する" || ng "失敗理由が違う" "$(cat "$WORK/ver-red3.err")"; fi
mk_versions 1.2.0 1.2.0 '^1.0.0' 1.2.0
if node "$BUILD" --source "$FX" --layout "$FX/layout-ver.json" --out "$WORK/fx-ver-ok2" >/dev/null 2>"$WORK/ver-ok2.err"; then ok "^1.0.0 は 1.2.0 を含む（対を置く）"; else ng "含む範囲で落ちた" "$(cat "$WORK/ver-ok2.err")"; fi

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
