#!/usr/bin/env bash
# Codex 用配布宣言を検査する。生成結果と実配布物は build-plugin.test.sh が検査する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node - "$REPO_ROOT" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
const layout = JSON.parse(fs.readFileSync(path.join(root, 'scripts/lib/plugin-layout.json'), 'utf8'))
const codex = Object.fromEntries(Object.entries(layout.codexHookScripts ?? {}).filter(([name]) => !name.startsWith('_')))
const shared = [
  'check-branch-pr-status.sh',
  'check-branch-tool-ownership.sh',
  'check-local-main-freshness.sh',
  'check-skip-marker-write.sh',
]
const adapter = 'codex-skip-marker-deny.sh'
const doctor = 'aidd-codex-doctor.sh'

assert.deepEqual(Object.keys(codex).sort(), [...shared, adapter, doctor].sort(), '4 hook と判定本体、doctor の6ファイル')
for (const name of Object.keys(codex)) {
  assert.equal(codex[name], 'aidd-codex', `${name} の Codex 所属`)
  assert.ok(fs.existsSync(path.join(root, 'scripts', name)), `${name} の正本が存在する`)
}
for (const name of shared) assert.equal(layout.hookScripts[name], 'aidd-core', `${name} の Claude 所属を維持する`)
assert.equal(layout.hookScripts[adapter], undefined, 'Codex 専用ラッパーを Claude 用生成器へ渡さない')
assert.equal(layout.supportScriptsUnclassified[adapter], undefined, '配布方針を決めたラッパーは未分類に残さない')

const source = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')))
for (const name of [...shared.slice(0, 3), adapter]) {
  assert.ok(source.includes(`/scripts/${name}`), `${name} は Codex の project hook に登録済み`)
}
console.log('Codex 用配布宣言: 6ファイル、既存所属、hook 登録を確認')
NODE
