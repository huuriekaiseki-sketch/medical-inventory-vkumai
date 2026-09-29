#!/bin/bash
# WHY: issue #348向けのPreToolUse hook(scripts/check-skip-marker-write.sh)の回帰テスト。
# 合成したtool_name/tool_inputのhook入力JSONを標準入力で渡し、
# .claude/.verify-state/*.skipへの書き込みを検知した場合にpermissionDecision: "ask"を
# 返すこと・それ以外は何も出力しないことを確認する。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md
#
# 実行: bash scripts/check-skip-marker-write.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_UNDER_TEST:-$SCRIPT_DIR/check-skip-marker-write.sh}"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

run_hook() {
  local input="$1"
  set +e
  OUT="$(printf '%s' "$input" | bash "$SCRIPT")"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: Bash + touch .skip → ask ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 2: Bash + echo x > .skip(リダイレクト経由) → ask ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "echo x > .claude/.verify-state/abc.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 3: Write file_path=.skip → ask ==="
input="$(jq -n '{tool_name: "Write", tool_input: {file_path: ".claude/.verify-state/abc.skip", content: "x"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 4: Bashで無関係な通常コマンド(npm test) → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm test"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 5: .verify-state配下だが.skip拡張子ではないファイル(cat *.json) → 何も出力しない ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "cat .claude/.verify-state/abc.json"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: cdで.verify-state配下に移動後、単一コマンドで相対touch → ask(issue #348回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "cd .claude/.verify-state && touch abc.skip"}, cwd: "/repo"}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 7: 事前にcd済みのcwdから相対touchのみを実行 → ask(issue #348回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch abc.skip"}, cwd: "/repo/.claude/.verify-state"}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 8: python3経由でフルパス書き込み → ask ==="
python3_cmd='python3 -c "open('"'"'.claude/.verify-state/abc.skip'"'"',\"w\").close()"'
input="$(jq -n --arg cmd "$python3_cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 9: node経由でフルパス書き込み → ask ==="
node_cmd='node -e "require('"'"'fs'"'"').writeFileSync('"'"'.claude/.verify-state/abc.skip'"'"',\"\")"'
input="$(jq -n --arg cmd "$node_cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 10: Editツールでfile_pathが.skip → ask ==="
input="$(jq -n '{tool_name: "Edit", tool_input: {file_path: ".claude/.verify-state/abc.skip", old_string: "x", new_string: "y"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 11: MultiEditツールでfile_pathが.skip → ask(マッチャー抜け漏れ修正) ==="
input="$(jq -n '{tool_name: "MultiEdit", tool_input: {file_path: ".claude/.verify-state/abc.skip", edits: [{old_string: "x", new_string: "y"}]}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "permissionDecision: askが出力される"

echo "=== scenario 12: cdを伴わないディレクトリ言及(ls)+無関係な.skipファイルへの操作 → 何も出力しない(誤検知修正の回帰) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "ls .claude/.verify-state && rm old-backup.skip"}}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(cdを伴わないディレクトリ参照は誤検知としない)"

echo "=== scenario 13: .claude/settings.jsonのmatcherと本スクリプトのcase文のツール一覧が一致する(matcher/case文の二重管理による抜け漏れの再発防止) ==="
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
MATCHER_TOOLS="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("check-skip-marker-write.sh")) | .matcher' "$SETTINGS_FILE" | tr '|' '\n' | sort)"
# WHY: apply_patch は Codex だけが使うツール名で、Claude の settings.json の matcher には現れない
# （Codex 側の matcher は Edit / Write が apply_patch のエイリアスとして効く）。
# 名前に _ が入っているので以前の正規表現では偶然拾われなかったが、偶然に頼らず明示的に外す。
CASE_TOOLS="$(grep -oE '^  [A-Za-z_]+(\|[A-Za-z_]+)*\)' "$SCRIPT" | grep -v '^  \*)' | tr -d ' )' | tr '|' '\n' | grep -vx 'apply_patch' | sort -u)"
assert_eq "$CASE_TOOLS" "$MATCHER_TOOLS" "settings.jsonのmatcherとcase文のツール一覧(Bash/Write/Edit/MultiEdit)が一致する(片方だけ変更されている場合はここで失敗する)"
if grep -qE '^  apply_patch\)' "$SCRIPT"; then echo "  OK: case文に Codex の apply_patch がある"; else echo "  NG: case文に apply_patch が無い（Codex のファイル編集が素通りする）"; fail=1; fi

echo "=== scenario 14: jq未インストール環境 → fail-closed(exit 2でブロック、issue #636) ==="
input="$(jq -n '{tool_name: "Bash", tool_input: {command: "touch .claude/.verify-state/x.skip"}}')"
set +e
OUT="$(printf '%s' "$input" | PATH="" /bin/bash "$SCRIPT" 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "exit 2(fail-closed)"
assert_contains "$OUT" "jq not found" "jq未検出のエラーメッセージが出る"

# --- Codex のファイル編集（apply_patch）。docs/specs/codex-hook-parity/01-apply-patch.md ---
# WHY: Codex はファイル編集を tool_name: "apply_patch" で渡し、パスは tool_input.file_path ではなく
# tool_input.command（パッチ本文）のヘッダ行に入る。Claude の形（Write/Edit + file_path）しか
# 見ていなかったため、Codex のファイル編集は丸ごと素通りしていた（2026-09-29 実測）。
run_patch() { # $1=パッチ本文 $2=cwd（省略時 /repo）
  run_hook "$(jq -n --arg c "$1" --arg d "${2:-/repo}" '{tool_name: "apply_patch", tool_input: {command: $c}, cwd: $d}')"
}

echo "=== scenario 15: apply_patch のヘッダ 4 種で .skip を触る → ask ==="
run_patch $'*** Begin Patch\n*** Add File: .claude/.verify-state/abc.skip\n+x\n*** End Patch'
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "ask"' "Add File は ask"
run_patch $'*** Begin Patch\n*** Update File: .claude/.verify-state/abc.skip\n@@\n-x\n+y\n*** End Patch'
assert_contains "$OUT" '"permissionDecision": "ask"' "Update File は ask"
run_patch $'*** Begin Patch\n*** Delete File: .claude/.verify-state/abc.skip\n*** End Patch'
assert_contains "$OUT" '"permissionDecision": "ask"' "Delete File は ask"
run_patch $'*** Begin Patch\n*** Update File: tmp/marker.txt\n*** Move to: .claude/.verify-state/abc.skip\n@@\n-x\n+y\n*** End Patch'
assert_contains "$OUT" '"permissionDecision": "ask"' "Move to（移動先が .skip）は ask"

echo "=== scenario 16: 複数ファイルのパッチで 1 つだけ該当 → 全体が ask ==="
run_patch $'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** Add File: .claude/.verify-state/abc.skip\n+x\n*** Update File: docs/b.md\n@@\n-1\n+2\n*** End Patch'
assert_contains "$OUT" '"permissionDecision": "ask"' "該当 1 + 非該当 2 は ask"

echo "=== scenario 17: 本文にパスが出るだけ → 何も出力しない（対照） ==="
run_patch $'*** Begin Patch\n*** Update File: docs/verify.md\n@@\n-old\n+スキップするには .claude/.verify-state/abc.skip を作る\n+*** Add File: .claude/.verify-state/abc.skip\n*** End Patch'
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "本文（+ 行）の中のパスとヘッダもどきは見ない"

echo "=== scenario 18: 無関係なパッチ・ヘッダの無い入力 → 何も出力しない（対照） ==="
run_patch $'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch'
assert_empty "$OUT" "無関係なファイルは沈黙"
run_patch $'*** Begin Patch\n*** Add File: .claude/.verify-state/abc.json\n+x\n*** End Patch'
assert_empty "$OUT" ".skip 以外は沈黙"
run_patch 'ヘッダの無い文字列'
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "ヘッダが 1 行も無ければ沈黙（全編集を止めない）"

echo "=== scenario 19: cwd 起点の相対パス → ask ==="
run_patch $'*** Begin Patch\n*** Add File: abc.skip\n+x\n*** End Patch' "/repo/.claude/.verify-state"
assert_contains "$OUT" '"permissionDecision": "ask"' "cwd が .verify-state で相対の abc.skip は ask"
run_patch $'*** Begin Patch\n*** Add File: .verify-state/abc.skip\n+x\n*** End Patch' "/repo/.claude"
assert_contains "$OUT" '"permissionDecision": "ask"' "cwd が .claude で .verify-state/abc.skip は ask"
run_patch $'*** Begin Patch\n*** Add File: abc.skip\n+x\n*** End Patch' "/repo"
assert_empty "$OUT" "cwd が無関係なら相対の abc.skip は沈黙（対照）"

echo "=== scenario 20: 行末が CRLF のパッチ → ask ==="
run_patch $'*** Begin Patch\r\n*** Add File: .claude/.verify-state/abc.skip\r\n+x\r\n*** End Patch\r\n'
assert_contains "$OUT" '"permissionDecision": "ask"' "CRLF でもヘッダを読める"

# --- 読むだけの操作は止めない。docs/specs/codex-hook-parity/03-readonly-false-deny.md ---
# WHY: コマンド文字列のどこかにパスが出ていれば止めていたので、中身を読むだけでも止まっていた
# （2026-09-29 実測）。Claude では確認を 1 回押せば済むが、Codex では止まったら人が手で
# 実行するしかなく、調べものが進まない。守りを緩める変更なので、通すものは決め打ちにする。
run_cmd() { # $1=command $2=cwd（省略時 /repo）
  run_hook "$(jq -n --arg c "$1" --arg d "${2:-/repo}" '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}')"
}
expect_ask() { run_cmd "$1" "${2:-}"; assert_eq "$EXIT_CODE" "0" "exit 0: $1"; assert_contains "$OUT" '"permissionDecision": "ask"' "ask: $1"; }
expect_silent() { run_cmd "$1" "${2:-}"; assert_eq "$EXIT_CODE" "0" "exit 0: $1"; assert_empty "$OUT" "沈黙: $1"; }

echo "=== scenario 21: 読むだけのコマンド 8 語 → 何も出力しない ==="
for cmd in 'cat .claude/.verify-state/abc.skip' 'ls -l .claude/.verify-state/abc.skip' 'head -1 .claude/.verify-state/abc.skip' \
           'tail -n 5 .claude/.verify-state/abc.skip' 'wc -c .claude/.verify-state/abc.skip' 'stat .claude/.verify-state/abc.skip' \
           'file .claude/.verify-state/abc.skip' 'grep -c x .claude/.verify-state/abc.skip' \
           'ls .claude/.verify-state/abc.skip && cat .claude/.verify-state/abc.skip'; do
  expect_silent "$cmd"
done
expect_silent 'cat abc.skip' '/repo/.claude/.verify-state'
expect_silent 'cd .claude/.verify-state && cat abc.skip'

echo "=== scenario 22: 読むコマンドでも書き込み先の指定が付いていたら → ask ==="
for cmd in 'cat a > .claude/.verify-state/abc.skip' 'cat a >> .claude/.verify-state/abc.skip' 'cat a >.claude/.verify-state/abc.skip' \
           'cat a | tee .claude/.verify-state/abc.skip' 'ls .claude/.verify-state/abc.skip; touch .claude/.verify-state/def.skip' \
           'cat .claude/.verify-state/abc.skip && rm .claude/.verify-state/abc.skip' 'grep x f 2>/dev/null > .claude/.verify-state/abc.skip'; do
  expect_ask "$cmd"
done
expect_ask 'cat a > abc.skip' '/repo/.claude/.verify-state'
expect_ask 'cd .claude/.verify-state && cat a > abc.skip'

echo "=== scenario 23: 読むコマンドの 8 語に無いものは、これまで通り → ask（対照） ==="
for cmd in 'touch .claude/.verify-state/abc.skip' 'cp a .claude/.verify-state/abc.skip' 'mv a .claude/.verify-state/abc.skip' \
           'rm .claude/.verify-state/abc.skip' 'sed -i "" s/a/b/ .claude/.verify-state/abc.skip' 'sudo cat .claude/.verify-state/abc.skip'; do
  expect_ask "$cmd"
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
