#!/bin/bash
# WHY(2026-10-23): **止める hook は、timeout とクラッシュでは止めていなかった。**
#
#      PreToolUse の deny / ask を返す hook 4 本（DDL 実行・読み取り専用ロールの Bash・依存変更・
#      skip マーカー）は、jq が無ければ exit 2 で拒否側へ倒れる（fail-closed）。しかし Claude Code は
#      hook が **timeout（5 秒）に達した・起動できなかった・0 / 2 以外で終わった**ときは判定なしとして
#      ツール呼び出しを通す（公式 hooks リファレンス「don't count on a stalled hook to act as a gate」）。
#      遅いマシンや `set -euo pipefail` 下の想定外エラー 1 つで、止めるはずの DDL が素通りする。
#
#      Claude Code 2.1.295 の `"onFailure": "block"` は、その失敗を「通す」から「止める」へ倒す指定。
#      ただし**付ける相手を間違えると逆に危ない**——警告だけの hook に付けると、timeout のたびに
#      作業が止まる（毎回止まる警告は外される。C-020 の裏返し）。だからここでは両方向を見る:
#
#   (a) PreToolUse に登録された hook のうち「止める」もの（スクリプト本文に
#       `log_hook_decision "<名>" "deny"` または `"ask"` の呼び出しがある。docs/specs/hook-decision-log.md の
#       記録が、その hook が止める側であることの機械で読める宣言）は `"onFailure": "block"` を持つ
#   (b) `onFailure` を持つ hook は (a) の「止める」hook だけ（warn・記録専用・PreToolUse 以外には付けない）
#   (c) 登録された command が指すスクリプトが実在する（不在のまま「止める側ではない」と読まない。C-054）
#   (d) 走査が空振りしていない（止める hook を 1 本も見つけられないのは走査の故障。C-044）
#   (e) fixture で (a)〜(c) を検知できる（RED 方向の自己検証。C-022）
#
#      配布物（dist/plugins/<Claude 用>/hooks/hooks.json）も同じ検査に掛ける。build-plugin が
#      settings.json の hook エントリをそのまま写すので、ここが通れば配布物も通るはずだが、
#      「はず」は見ない（生成器の写し漏れは生成器のテストの担当で、ここは結果だけを見る）。
#
#      限界: `onFailure` が実機で本当に止めるかは測れない（2.1.295 未満の本体では無視される可能性があり、
#      旧版で未知キーが設定ファイルごと読まれなくなるかも未確認）。実機は hook-live-drill.md の担当。
#      Codex 側（.codex/hooks.json）には相当する指定が無いので対象外（docs/plugin/KNOWN-LIMITS.md）。
#
# 実行: bash scripts/check-blocking-hooks-onfailure.test.sh
# 環境変数（テスト用注入ポイント）:
#   CLAUDE_SETTINGS_PATH   既定 <repo>/.claude/settings.json
#   HOOK_SCRIPTS_DIR       既定 <repo>/scripts（settings の command が指すスクリプトの置き場）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**の .claude/settings.json を探す（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
SETTINGS="${CLAUDE_SETTINGS_PATH:-$REPO_ROOT/.claude/settings.json}"
SCRIPTS_DIR="${HOOK_SCRIPTS_DIR:-$REPO_ROOT/scripts}"

if [ ! -f "$SETTINGS" ]; then
  echo "=== scenario 0: この導入先には .claude/settings.json が無い ==="
  echo "  SKIP: PreToolUse の配線を確かめる相手が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "jq が必要です"; exit 1; }

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# command 文字列からスクリプトのファイル名を取る。
# `$CLAUDE_PROJECT_DIR/scripts/x.sh` / `"${CLAUDE_PLUGIN_ROOT}"/scripts/x.sh --flag` のどちらも x.sh。
script_name_of() {
  local first
  first="$(printf '%s' "$1" | awk '{print $1}')"
  first="${first%\"}"
  basename "$first"
}

# スクリプトが「止める側」か。本文に `log_hook_decision "<名>" "deny"|"ask"` の呼び出しがあれば 1。
# 関数の差し替え `log_hook_decision() { :; }` は `(` があるので当たらない。
is_stopping_script() {
  grep -qE '^[[:space:]]*log_hook_decision[[:space:]]+"[^"]+"[[:space:]]+"(deny|ask)"' "$1"
}

# 検査本体。$1=settings/hooks.json、$2=スクリプトの置き場。
# 違反を行で出し、末尾 2 行に stopping=N と violations=N
check() {
  local settings="$1" scripts_dir="$2" violations=0 stopping=0
  local events event n_groups gi n_hooks hi cmd name path on_failure
  if ! jq -e '.hooks | type == "object" and length > 0' "$settings" >/dev/null 2>&1; then
    echo "    empty: hooks が無い（${settings}）"
    echo "stopping=0"
    echo "violations=1"
    return
  fi
  events="$(jq -r '.hooks | keys[]' "$settings")"
  for event in $events; do
    n_groups="$(jq ".hooks[\"$event\"] | length" "$settings")"
    for ((gi = 0; gi < n_groups; gi++)); do
      n_hooks="$(jq ".hooks[\"$event\"][$gi].hooks | length" "$settings")"
      for ((hi = 0; hi < n_hooks; hi++)); do
        cmd="$(jq -r ".hooks[\"$event\"][$gi].hooks[$hi].command // \"\"" "$settings")"
        [ -n "$cmd" ] || continue
        name="$(script_name_of "$cmd")"
        path="$scripts_dir/$name"
        on_failure="$(jq -r ".hooks[\"$event\"][$gi].hooks[$hi].onFailure // \"\"" "$settings")"
        if [ ! -f "$path" ]; then
          echo "    script-missing: $event の $name が $scripts_dir に無い（止める側かを判定できない）"
          violations=$((violations + 1))
          continue
        fi
        if [ "$event" = "PreToolUse" ] && is_stopping_script "$path"; then
          stopping=$((stopping + 1))
          case "$on_failure" in
            block) ;;
            "")
              echo "    missing-onfailure: PreToolUse の $name は deny / ask を返す hook だが onFailure が無い（timeout・クラッシュで素通りする）"
              violations=$((violations + 1))
              ;;
            *)
              echo "    wrong-onfailure: PreToolUse の $name の onFailure が \"$on_failure\"（block 以外）"
              violations=$((violations + 1))
              ;;
          esac
        elif [ -n "$on_failure" ]; then
          echo "    stray-onfailure: $event の $name は止める hook ではないのに onFailure=\"$on_failure\"（timeout のたびに作業が止まる）"
          violations=$((violations + 1))
        fi
      done
    done
  done
  echo "stopping=$stopping"
  echo "violations=$violations"
}

report() {
  # $1=ラベル、$2=check の出力、$3=止める hook が 1 本以上要るか（1/0）
  local label="$1" result="$2" need_stopping="$3" stopping violations
  stopping="$(grep '^stopping=' <<<"$result" | cut -d= -f2)"
  violations="$(tail -n1 <<<"$result" | cut -d= -f2)"
  grep -v -e '^violations=' -e '^stopping=' <<<"$result" || true
  if [ "$violations" != "0" ]; then
    ng "$label: 違反あり" "violations=$violations"
  elif [ "$need_stopping" = "1" ] && [ "${stopping:-0}" -eq 0 ]; then
    ng "$label: 走査が空振り（止める hook を 1 本も見つけられない。C-044）"
  else
    ok "$label: 違反なし（止める hook ${stopping} 本に onFailure=block）"
  fi
}

echo "=== scenario 1: 実態の settings.json で、止める hook だけが onFailure=block を持つ ==="
# WHY(2026-09-12): 導入先の settings.json には AIDD の登録が 0 件のことがある（登録はプラグインの
#      hooks.json 側）。0 件を違反として読むと、正しく入れた導入先ほど赤くなる（E-086）。
AIDD_REGISTERED_N="$(jq '[.hooks // {} | to_entries[].value[]?.hooks[]?.command | select(test("scripts/"))] | length' "$SETTINGS" 2>/dev/null || echo 0)"
if [ "${AIDD_REGISTERED_N:-0}" -eq 0 ]; then
  ok "この導入先の settings.json には AIDD の hook 登録が無い（プラグイン側で登録される）ので対象なし"
else
  report ".claude/settings.json" "$(check "$SETTINGS" "$SCRIPTS_DIR")" 1
fi

echo "=== scenario 1b: 配布物（Claude 用プラグイン）の hooks.json も同じ ==="
DIST="$REPO_ROOT/dist/plugins"
found_dist=0
if [ -d "$DIST" ]; then
  for plugin_dir in "$DIST"/*/; do
    [ -f "$plugin_dir/.claude-plugin/plugin.json" ] || continue
    [ -f "$plugin_dir/hooks/hooks.json" ] || continue
    found_dist=1
    report "$(basename "$plugin_dir")/hooks/hooks.json" "$(check "$plugin_dir/hooks/hooks.json" "$plugin_dir/scripts")" 0
  done
fi
[ "$found_dist" -eq 1 ] || ok "配布物が無い（導入先）ので対象なし"

echo "=== scenario 2: fixture で違反をちょうど検知する（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts"
cat > "$WORK/scripts/stop-deny.sh" <<'EOF'
#!/bin/bash
log_hook_decision() { :; }
log_hook_decision "stop-deny" "deny" "rule" "Bash" "target" "$INPUT"
EOF
cat > "$WORK/scripts/stop-ask.sh" <<'EOF'
#!/bin/bash
  log_hook_decision "stop-ask" "ask" "$RULE" "$TOOL_NAME" "$T" "$INPUT"
EOF
cat > "$WORK/scripts/warn-only.sh" <<'EOF'
#!/bin/bash
log_hook_decision "warn-only" "warn" "rule" "Write" "target" "$INPUT"
EOF
cat > "$WORK/scripts/plain.sh" <<'EOF'
#!/bin/bash
# 判定を出さない記録専用の hook。関数の差し替えだけがある
log_hook_decision() { :; }
EOF

# 違反 6 種: onFailure 無し / block 以外 / warn に付けた / 記録専用に付けた / PreToolUse 以外に付けた / スクリプト不在
cat > "$WORK/bad.json" <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/stop-deny.sh", "timeout": 5 },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/stop-ask.sh", "timeout": 5, "onFailure": "continue" },
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/warn-only.sh", "timeout": 5, "onFailure": "block" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/plain.sh", "onFailure": "block" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/ghost.sh", "onFailure": "block" }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/stop-deny.sh", "onFailure": "block" } ] }
    ]
  }
}
EOF
RESULT="$(check "$WORK/bad.json" "$WORK/scripts")"
if [ "$(tail -n1 <<<"$RESULT")" = "violations=6" ]; then ok "違反 6 件をちょうど検知"; else ng "違反件数が 6 でない" "$RESULT"; fi
for needle in 'missing-onfailure: PreToolUse の stop-deny.sh' 'wrong-onfailure: PreToolUse の stop-ask.sh' \
              'stray-onfailure: PreToolUse の warn-only.sh' 'stray-onfailure: PreToolUse の plain.sh' \
              'stray-onfailure: Stop の stop-deny.sh' 'script-missing: PreToolUse の ghost.sh'; do
  if grep -qF "$needle" <<<"$RESULT"; then ok "検知: $needle"; else ng "検知できない: $needle" "$RESULT"; fi
done

cat > "$WORK/good.json" <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/stop-deny.sh", "timeout": 5, "onFailure": "block" },
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/stop-ask.sh --flag", "onFailure": "block" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/warn-only.sh", "timeout": 5 },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/plain.sh" }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/plain.sh" } ] }
    ]
  }
}
EOF
RESULT="$(check "$WORK/good.json" "$WORK/scripts")"
if [ "$(tail -n1 <<<"$RESULT")" = "violations=0" ]; then ok "正しい構成は誤検知しない"; else ng "正しい構成を誤検知" "$RESULT"; fi
if grep -qx 'stopping=2' <<<"$RESULT"; then ok "止める hook を 2 本と数える（deny と ask。warn と記録専用は数えない）"; else ng "止める hook の数え方が違う" "$RESULT"; fi

echo "=== scenario 3: hooks の無い設定は違反として扱う（fail-open 防止） ==="
printf '{"permissions":{}}\n' > "$WORK/nohooks.json"
RESULT="$(check "$WORK/nohooks.json" "$WORK/scripts")"
if grep -qF 'empty:' <<<"$RESULT"; then ok "hooks 不在を違反として出す"; else ng "hooks 不在で黙る" "$RESULT"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
