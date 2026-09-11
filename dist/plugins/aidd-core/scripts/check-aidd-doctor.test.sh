#!/usr/bin/env bash
# WHY(2026-09-11): 検知 hook はほぼすべて fail-open（材料が取れなければ沈黙）で、
#   **壊れても何も起きない**。実走ドリル（docs/agents/hook-live-drill.md）は同じ問題を
#   人が打つ手順として持ち、2026-09-05 に回して 1 日で 7 件の無音死を見つけた。
#   だが起動が人なので忘れれば止まる（次回予定は四半期後）。
#
#   この検査は**その前段**を機械化する——「動かす前に、動く条件が揃っているか」。
#   走査の本体は scripts/lib/aidd-doctor.mjs。
#
#   実測して分かったこと（2026-09-11）: hook の実体は 42 本で、**41 本が `jq` を呼ぶ**。
#   `jq` が無い環境では **32 本が黙って降りる**（4 本は拒否側へ倒れ、5 本は読み切れない）。
#   配布物の KNOWN-LIMITS は node / python3 / npx しか挙げておらず、**実態より狭かった**。
#
# 実行: bash scripts/check-aidd-doctor.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCTOR="${SCRIPT_DIR}/lib/aidd-doctor.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "${TMP_ROOT}"; }
trap cleanup EXIT

echo "=== scenario 1: 実物の hook を列挙できている ==="
out="$(node "${DOCTOR}" "${REPO_ROOT}" --verbose 2>&1)"
status=$?
scripts_n="$(printf '%s' "${out}" | sed -n 's/.*scripts=\([0-9]*\).*/\1/p' | tail -1)"
if [ -n "${scripts_n}" ] && [ "${scripts_n}" -ge 30 ]; then
  ok "hook の実体を ${scripts_n} 本見つけた"
else
  ng "hook をほとんど見つけられない（列挙が壊れている疑い）" "${out}"
fi
# この環境で足りない実行系があれば、それは本当の警告なので落とさず知らせる
if [ "${status}" -eq 0 ]; then
  ok "この環境では沈黙しうる hook が無い"
else
  echo "  注意: この環境には足りない実行系がある（下記）"
  printf '%s\n' "${out}" | sed -n 's/^aidd-doctor: /      /p'
fi

echo "=== scenario 2: 実行系が無いと名指しする（RED 方向の自己検証） ==="
out="$(AIDD_DOCTOR_ASSUME_MISSING=jq node "${DOCTOR}" "${REPO_ROOT}" 2>&1)"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "jq が無いので"; then
  ok "jq が無い場合を名指しする"
else
  ng "jq が無くても黙っている（この検査自体が沈黙している）" "${out}"
fi
at_risk="$(printf '%s' "${out}" | sed -n 's/.*atRisk=\([0-9]*\).*/\1/p' | tail -1)"
if [ -n "${at_risk}" ] && [ "${at_risk}" -ge 10 ]; then
  ok "影響する本数を数える（${at_risk} 本）"
else
  ng "本数を数えられていない" "${out}"
fi

echo "=== scenario 3: 黙って降りる／拒否側へ倒れる を区別する ==="
out="$(AIDD_DOCTOR_ASSUME_MISSING=jq node "${DOCTOR}" "${REPO_ROOT}" 2>&1)"
if printf '%s' "${out}" | grep -q "黙って降りる"; then
  ok "沈黙する側を数える"
else
  ng "沈黙と拒否を区別していない" "${out}"
fi
if printf '%s' "${out}" | grep -q "拒否側へ倒れる"; then
  ok "拒否側へ倒れる側も数える（安全側は別に数える）"
else
  ng "拒否側を数えていない" "${out}"
fi

echo "=== scenario 4: 複数の実行系をまとめて見る ==="
out="$(AIDD_DOCTOR_ASSUME_MISSING=jq,python3 node "${DOCTOR}" "${REPO_ROOT}" 2>&1)"
if printf '%s' "${out}" | grep -q "jq が無いので" && printf '%s' "${out}" | grep -q "python3 が無いので"; then
  ok "2 つとも名指しする"
else
  ng "片方しか見ていない" "${out}"
fi

echo "=== scenario 5: hook が 0 本なら落ちる（fail-open 防止） ==="
mkdir -p "${TMP_ROOT}/empty/.claude"
echo '{}' > "${TMP_ROOT}/empty/.claude/settings.json"
out="$(node "${DOCTOR}" "${TMP_ROOT}/empty" 2>&1)"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "見つけられなかった"; then
  ok "hook が 0 本なら落ちる"
else
  ng "hook が 0 本でも通ってしまう" "${out}"
fi

echo "=== scenario 6: プラグインの hooks.json も読む（導入先の形） ==="
mkdir -p "${TMP_ROOT}/consumer/.claude" "${TMP_ROOT}/plug/hooks" "${TMP_ROOT}/plug/scripts"
echo '{}' > "${TMP_ROOT}/consumer/.claude/settings.json"
cat > "${TMP_ROOT}/plug/hooks/hooks.json" <<'HOOKS'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PLUGIN_ROOT/scripts/probe-thing.sh\"" }] }
    ]
  }
}
HOOKS
cat > "${TMP_ROOT}/plug/scripts/probe-thing.sh" <<'PROBE'
#!/usr/bin/env bash
command -v jq >/dev/null 2>&1 || exit 0
jq -r '.x' <<< '{}'
PROBE
out="$(AIDD_DOCTOR_ASSUME_MISSING=jq node "${DOCTOR}" "${TMP_ROOT}/consumer" --plugin-root "${TMP_ROOT}/plug" 2>&1)"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "probe-thing.sh"; then
  ok "プラグイン側の hook も名指しする"
else
  ng "プラグイン側を見ていない（導入先で効かない）" "${out}"
fi

echo "=== scenario 7: 実行系が揃っていれば黙って通る（誤検知しない） ==="
out="$(node "${DOCTOR}" "${TMP_ROOT}/consumer" --plugin-root "${TMP_ROOT}/plug" 2>&1)"
if [ $? -eq 0 ]; then
  ok "揃っていれば通る"
else
  ng "揃っているのに警告する" "${out}"
fi

echo "=== scenario 10: Codex 側の hook（.codex/hooks.json）も数える ==="
# WHY(2026-09-11): このリポジトリは Claude と Codex の両方で作業する。Codex 側の hook は
#      **同じスクリプトを呼ぶ**ので同じ実行系に依存するが、最初の版は `.claude/settings.json` と
#      プラグインしか見ておらず、**Codex では沈黙していることに気づけなかった**。
mkdir -p "${TMP_ROOT}/both/.claude" "${TMP_ROOT}/both/.codex" "${TMP_ROOT}/both/scripts"
# WHY(両方に hook を置く): 片方しか無い fixture では「片方に無い」を判定できない。
#      claude 側に SessionStart、codex 側に Stop を置いて、**互いに無いイベント**を作る
cat > "${TMP_ROOT}/both/.claude/settings.json" <<'CLAUDEHOOKS'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/claude-only-thing.sh" }] }
    ]
  }
}
CLAUDEHOOKS
cat > "${TMP_ROOT}/both/scripts/claude-only-thing.sh" <<'CLAUDESCRIPT'
#!/usr/bin/env bash
command -v jq >/dev/null 2>&1 || exit 0
jq -n '{}'
CLAUDESCRIPT
cat > "${TMP_ROOT}/both/.codex/hooks.json" <<'CODEXHOOKS'
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"$(git rev-parse --show-toplevel)\"/scripts/codex-only-thing.sh" }] }
    ]
  }
}
CODEXHOOKS
cat > "${TMP_ROOT}/both/scripts/codex-only-thing.sh" <<'CODEXSCRIPT'
#!/usr/bin/env bash
command -v jq >/dev/null 2>&1 || exit 0
jq -n '{}'
CODEXSCRIPT
out="$(AIDD_DOCTOR_ASSUME_MISSING=jq node "${DOCTOR}" "${TMP_ROOT}/both" 2>&1)"
if [ $? -ne 0 ] && printf '%s' "${out}" | grep -q "codex-only-thing.sh"; then
  ok "Codex 側の hook も名指しする"
else
  ng "Codex 側を見ていない（片方のツールでだけ沈黙していても気づけない）" "${out}"
fi

echo "=== scenario 11: イベント別の対応を並べ、片方に無いものを名指しする ==="
# WHY(2026-09-11): 「Codex 側には Stop hook が 1 本も無い」ことに**人が目視で気づいた**。
#      揃えるべきかどうかは人が決めるが、**並べるところまでは機械がやる**。
out="$(node "${DOCTOR}" "${TMP_ROOT}/both" --verbose 2>&1)"
if printf '%s' "${out}" | grep -q "イベント別"; then
  ok "イベント別の対応を出す"
else
  ng "対応表を出していない（片方に無い検知に人しか気づけない）" "${out}"
fi
if printf '%s' "${out}" | grep -q "に無い"; then
  ok "片方にしか無いイベントを名指しする"
else
  ng "欠落を名指ししない" "${out}"
fi

echo "=== scenario 8: 依存を伝える hook 自身が、その依存を要求しない（自己言及の罠） ==="
# WHY: `jq` が無いことを伝える hook が `jq` で JSON を組んでいたら、**まさにその状況で黙る**。
#      jq だけを PATH から外した環境を作り、それでも systemMessage が出ることを見る。
HOOK="${SCRIPT_DIR}/check-hook-dependencies.sh"
if [ ! -f "${HOOK}" ]; then
  ng "hook 本体が無い" "${HOOK}"
else
  FAKE_BIN="${TMP_ROOT}/nojq/bin"
  mkdir -p "${FAKE_BIN}"
  for c in dirname basename sed grep printf cat node env bash mktemp rm; do
    p="$(command -v "${c}" 2>/dev/null || true)"
    [ -n "${p}" ] && ln -sf "${p}" "${FAKE_BIN}/${c}"
  done
  if PATH="${FAKE_BIN}" command -v jq >/dev/null 2>&1; then
    ng "jq を隠せていない（この検査が空振りしている）"
  else
    out="$(PATH="${FAKE_BIN}" AIDD_DOCTOR_ASSUME_MISSING=jq bash "${HOOK}" 2>&1)"
    if printf '%s' "${out}" | grep -q "systemMessage"; then
      ok "jq が無くても伝えられる"
    else
      ng "jq が無いと、それを伝える hook まで黙る" "${out}"
    fi
  fi
fi

echo "=== scenario 9: 揃っている環境では hook が黙る（誤検知しない） ==="
if [ -f "${HOOK}" ]; then
  out="$(bash "${HOOK}" 2>&1)"
  if [ -z "${out}" ]; then
    ok "揃っていれば無言（警告疲れを作らない）"
  else
    echo "  注意: この環境に足りない実行系があるため出力あり（scenario 1 と同じ理由）"
  fi
fi

if [ "${fail}" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
