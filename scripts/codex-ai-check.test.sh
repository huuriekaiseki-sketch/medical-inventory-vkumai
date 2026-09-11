#!/usr/bin/env bash
# WHY(2026-09-11): Codex 側には Stop hook が 1 本も無く、**セッション終了時の警告が
#   Codex には一切出ていなかった**。同じ人が同じリポジトリを触っていても、
#   使うツールで守りの厚みが変わっていた（Claude 側には `ai-check-suggest.sh` がある）。
#   派生先で先に作られていた 2 本組を逆輸入し、vkumai の流儀へ直した。
#
#   Claude 版は transcript から「打った Bash コマンド」を直接読むが、
#   **Codex の transcript は形式が安定しない**ので同じ手が使えない。
#   代わりに PostToolUse で「打った瞬間のソースの姿」を残し、Stop でいまの姿と比べる。
#
# 実行: bash scripts/codex-ai-check.test.sh
#   実リポジトリを汚さないよう、一時 git リポジトリを作ってそこで動かす。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TRACK="${SCRIPT_DIR}/codex-ai-check-track.sh"
SUGGEST="${SCRIPT_DIR}/codex-ai-check-suggest.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "${TMP_ROOT}"; }
trap cleanup EXIT

# 一時リポジトリを作る（実リポジトリのソースには触らない）
WORK="${TMP_ROOT}/repo"
mkdir -p "${WORK}/src"
git -C "${WORK}" init -q 2>/dev/null || git init -q "${WORK}"
git -C "${WORK}" config user.email probe@example.com
git -C "${WORK}" config user.name probe
echo "export const a = 1" > "${WORK}/src/a.ts"
git -C "${WORK}" add -A
git -C "${WORK}" commit -qm init

export CODEX_AI_CHECK_STATE_DIR="${TMP_ROOT}/state"

run_suggest() { (cd "${WORK}" && printf '%s' "$1" | bash "${SUGGEST}" 2>&1); }
run_track() { (cd "${WORK}" && printf '%s' "$1" | bash "${TRACK}" 2>&1); }

echo "=== scenario 1: ソースを触っていなければ黙る ==="
out="$(run_suggest '{"session_id":"s1"}')"
if [ -z "${out}" ]; then
  ok "無言（警告疲れを作らない）"
else
  ng "触っていないのに何か言う" "${out}"
fi

echo "=== scenario 2: ソースを触って未実行なら警告する ==="
echo "export const a = 2" > "${WORK}/src/a.ts"
out="$(run_suggest '{"session_id":"s2"}')"
if grep -q "systemMessage" <<<"${out}"; then
  ok "警告する"
else
  ng "触ったのに黙っている（Codex 側が無警告のままになる）" "${out}"
fi

echo "=== scenario 3: 品質チェックを打つと記録が残る ==="
run_track '{"session_id":"s2","tool_name":"Bash","tool_input":{"command":"npm run typecheck"}}' >/dev/null
if [ -f "${CODEX_AI_CHECK_STATE_DIR}/s2.hash" ]; then
  ok "記録が残る"
else
  ng "記録されない（Stop が毎回警告する側に倒れる）"
fi

echo "=== scenario 4: 打った直後は黙る ==="
out="$(run_suggest '{"session_id":"s2"}')"
if [ -z "${out}" ]; then
  ok "打ってあれば無言"
else
  ng "打ったのに警告する（誤検知）" "${out}"
fi

echo "=== scenario 5: 打った後にさらに触ると、また警告する ==="
# WHY: ここが**ファイル名だけを見る実装との差**。同じファイルを編集し続けても検知する
echo "export const a = 3" > "${WORK}/src/a.ts"
out="$(run_suggest '{"session_id":"s2"}')"
if grep -q "systemMessage" <<<"${out}"; then
  ok "打った後の変更を見つける"
else
  ng "同じファイルを触り続けると見逃す（内容をハッシュに入れていない疑い）" "${out}"
fi

echo "=== scenario 6: 品質チェック以外のコマンドでは記録しない ==="
rm -f "${CODEX_AI_CHECK_STATE_DIR}/s6.hash"
run_track '{"session_id":"s6","tool_name":"Bash","tool_input":{"command":"git status"}}' >/dev/null
if [ ! -f "${CODEX_AI_CHECK_STATE_DIR}/s6.hash" ]; then
  ok "無関係なコマンドは数えない"
else
  ng "何を打っても実行済みになる（判定が死んでいる）"
fi

echo "=== scenario 7: Bash 以外のツールでは記録しない ==="
rm -f "${CODEX_AI_CHECK_STATE_DIR}/s7.hash"
run_track '{"session_id":"s7","tool_name":"Edit","tool_input":{"command":"npm run typecheck"}}' >/dev/null
if [ ! -f "${CODEX_AI_CHECK_STATE_DIR}/s7.hash" ]; then
  ok "Bash 以外は数えない"
else
  ng "ツール名を見ていない"
fi

echo "=== scenario 8: docs だけの変更では警告しない ==="
git -C "${WORK}" checkout -q -- src/a.ts
echo "# doc" > "${WORK}/README.md"
out="$(run_suggest '{"session_id":"s8"}')"
if [ -z "${out}" ]; then
  ok "ソース以外の変更では黙る"
else
  ng "docs を触っただけで警告する（警告疲れ）" "${out}"
fi
rm -f "${WORK}/README.md"

echo "=== scenario 9: .codex/hooks.json に PostToolUse と Stop が登録されている ==="
HOOKS="${REPO_ROOT}/.codex/hooks.json"
if [ ! -f "${HOOKS}" ]; then
  ng ".codex/hooks.json が無い"
else
  if grep -q "codex-ai-check-track.sh" "${HOOKS}"; then
    ok "PostToolUse に track が登録されている"
  else
    ng "track が登録されていない（記録が残らず、Stop が毎回警告する）"
  fi
  if grep -q "codex-ai-check-suggest.sh" "${HOOKS}"; then
    ok "Stop に suggest が登録されている"
  else
    ng "suggest が登録されていない（Codex は無警告のまま）"
  fi
fi

echo "=== scenario 10: 状態ファイルが git に入らない ==="
if grep -q "^/\.codex/\.ai-check-suggest-state/" "${REPO_ROOT}/.gitignore"; then
  ok "gitignore されている"
else
  ng "セッションごとのハッシュがコミットされてしまう"
fi

if [ "${fail}" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
