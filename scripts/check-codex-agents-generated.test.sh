#!/usr/bin/env bash
# WHY(2026-09-11): agent 定義が 2 か所にあり、**同じことを二重に書いていた**。
#   `.claude/agents/*.md`（Claude）と `.codex/agents/*.toml`（Codex）。
#   実測すると、そろっているつもりの欄がずれていた——
#   `description` が 2 本、`effort` が 6 本。どれも手で写す限りまた起きる。
#   **メタデータは md から生成する**ことにした（間違えられる道を無くす）。
#   生成の本体は scripts/lib/generate-codex-agents.mjs。
#
#   本文（developer_instructions）は**まだ生成しない**。Codex 側は Claude 側の 25〜40% に
#   圧縮されており、sweep 系では「既知の失敗パターン」「決定的な探索手順」が落ちている。
#   それが意図的かどうかどこにも書かれていないので、いま写すと振る舞いが変わる。
#   **ずれの大きさを数えるだけ**にして、写すかどうかは人が決める（段階的）。
#
# 実行: bash scripts/check-codex-agents-generated.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
GEN="${SCRIPT_DIR}/lib/generate-codex-agents.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "${TMP_ROOT}"; }
trap cleanup EXIT

echo "=== scenario 1: 実物の toml が md から生成したものと一致する ==="
out="$(node "${GEN}" "${REPO_ROOT}" 2>&1)"
if [ $? -eq 0 ]; then
  ok "一致している（${out}）"
else
  ng "md と食い違っている（node scripts/lib/generate-codex-agents.mjs --write で直す）" "${out}"
fi

echo "=== scenario 2: 正本の md がリポジトリに無い agent を落とす ==="
# WHY: Claude 側がグローバル（~/.claude/agents/）にしか無いと、**派生先へ配れない**。
#      実際 proposer がその状態だった（Codex 側はリポジトリ内にあるのに）。
mkdir -p "${TMP_ROOT}/onlycodex/.claude/agents" "${TMP_ROOT}/onlycodex/.codex/agents"
cat > "${TMP_ROOT}/onlycodex/.codex/agents/ghost.toml" <<'GHOST'
name = "ghost"
description = "d"
sandbox_mode = "read-only"
developer_instructions = """本文"""
GHOST
out="$(node "${GEN}" "${TMP_ROOT}/onlycodex" 2>&1)"
if [ $? -ne 0 ] && grep -q "only-codex: ghost" <<<"${out}"; then
  ok "md が無い agent を名指しする"
else
  ng "リポジトリに正本が無くても通ってしまう" "${out}"
fi

echo "=== scenario 3: md を変えたら食い違いとして出る（RED 方向） ==="
mkdir -p "${TMP_ROOT}/drift/.claude/agents" "${TMP_ROOT}/drift/.codex/agents"
cat > "${TMP_ROOT}/drift/.claude/agents/thing.md" <<'MD'
---
name: thing
description: 新しい説明
tools: Read, Bash
model: haiku
effort: low
---

本文
MD
cat > "${TMP_ROOT}/drift/.codex/agents/thing.toml" <<'TOML'
name = "thing"
description = "古い説明"
model_reasoning_effort = "low"
sandbox_mode = "read-only"
developer_instructions = """Codex 用の本文"""
TOML
out="$(node "${GEN}" "${TMP_ROOT}/drift" 2>&1)"
if [ $? -ne 0 ] && grep -q "stale: thing.toml" <<<"${out}"; then
  ok "食い違いを名指しする"
else
  ng "md を変えても気づかない（二重管理のまま）" "${out}"
fi

echo "=== scenario 4: 生成しても本文は保つ（段階的にしている点） ==="
node "${GEN}" "${TMP_ROOT}/drift" --write >/dev/null 2>&1
if grep -q 'Codex 用の本文' "${TMP_ROOT}/drift/.codex/agents/thing.toml"; then
  ok "本文は書き換えない"
else
  ng "本文まで上書きした（Codex 側の振る舞いが変わる）"
fi
if grep -q '新しい説明' "${TMP_ROOT}/drift/.codex/agents/thing.toml"; then
  ok "メタデータは md から写る"
else
  ng "メタデータが写っていない"
fi

echo "=== scenario 5: tools から sandbox_mode を決める（書き込みの有無） ==="
mkdir -p "${TMP_ROOT}/sandbox/.claude/agents" "${TMP_ROOT}/sandbox/.codex/agents"
cat > "${TMP_ROOT}/sandbox/.claude/agents/writer.md" <<'MD'
---
name: writer
description: d
tools: Read, Edit, Write, Bash
model: sonnet
---

本文
MD
cat > "${TMP_ROOT}/sandbox/.codex/agents/writer.toml" <<'TOML'
name = "writer"
description = "d"
sandbox_mode = "read-only"
developer_instructions = """本文"""
TOML
node "${GEN}" "${TMP_ROOT}/sandbox" --write >/dev/null 2>&1
if grep -q 'sandbox_mode = "workspace-write"' "${TMP_ROOT}/sandbox/.codex/agents/writer.toml"; then
  ok "Edit / Write があれば workspace-write"
else
  ng "書き込む agent が read-only のまま（Codex で作業できない）"
fi

echo "=== scenario 6: 本文を読めない toml は触らない（壊すより止まる） ==="
mkdir -p "${TMP_ROOT}/nobody/.claude/agents" "${TMP_ROOT}/nobody/.codex/agents"
cat > "${TMP_ROOT}/nobody/.claude/agents/odd.md" <<'MD'
---
name: odd
description: d
tools: Read
model: haiku
---

本文
MD
printf 'name = "odd"\ndescription = "d"\n' > "${TMP_ROOT}/nobody/.codex/agents/odd.toml"
out="$(node "${GEN}" "${TMP_ROOT}/nobody" 2>&1)"
if [ $? -ne 0 ] && grep -q "no-body: odd" <<<"${out}"; then
  ok "読めない toml を名指しして止まる"
else
  ng "読めない toml を黙って上書きする恐れ" "${out}"
fi

echo "=== scenario 8: 本文のずれが上限を超えていない（写さないと決めた分を数える） ==="
# WHY: メタデータは生成するようにしたが、本文はまだ写していない（振る舞いが変わるため）。
#      写さない代わりに「Claude 側にあって Codex 側に無い節」の総数に上限を張り、
#      **黙って増えていくことだけを止める**。減らすのは人が決める。
BUDGET="${SCRIPT_DIR}/lib/codex-agent-drift-budget.json"
if [ ! -f "${BUDGET}" ]; then
  ng "上限の台帳が無い（${BUDGET}）"
else
  MAX="$(node --input-type=module -e "
import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync('${BUDGET}', 'utf8'))
process.stdout.write(String(j.max?.missingSections ?? ''))
")"
  NOW="$(node "${GEN}" "${REPO_ROOT}" 2>&1 | sed -n 's/.*missingSections=\([0-9]*\).*/\1/p' | tail -1)"
  if [ -z "${MAX}" ] || [ -z "${NOW}" ]; then
    ng "上限か実測を読めない" "max=${MAX} now=${NOW}"
  elif [ "${NOW}" -le "${MAX}" ]; then
    ok "上限内（いま ${NOW} / 上限 ${MAX}）"
  else
    ng "Codex 側に無い節が増えた（いま ${NOW} / 上限 ${MAX}）" "写すか、上限を上げる理由を台帳に書く"
  fi
  # fail-open 防止: 数えられていない（0 件）なら、走査が壊れている疑い
  if [ -n "${NOW}" ] && [ "${NOW}" -eq 0 ] && [ "${MAX}" -gt 0 ]; then
    ng "ずれが 0 と出た（上限は ${MAX}）。走査が壊れている疑い"
  fi
fi

echo "=== scenario 7: agent が 0 本の導入先では黙って通る ==="
mkdir -p "${TMP_ROOT}/empty"
out="$(node "${GEN}" "${TMP_ROOT}/empty" 2>&1)"
if [ $? -eq 0 ]; then
  ok "Codex を使わない導入先では何も言わない"
else
  ng "agent が無いのに落ちる" "${out}"
fi

if [ "${fail}" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
