#!/usr/bin/env bash
# Codex 用配布宣言を検査する。生成結果と実配布物は build-plugin.test.sh が検査する。
# WHY(2026-09-28): aidd-codex（共通）と aidd-codex-vkumai（vkumai 固有）の 2 プラグインに分けた。
#   共通側に固有の hook が混ざらないこと、固有側の判定本体が Claude 側 aidd-vkumai と同じ正本であることを見る。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node - "$REPO_ROOT" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
const layout = JSON.parse(fs.readFileSync(path.join(root, 'scripts/lib/plugin-layout.json'), 'utf8'))
const codex = Object.fromEntries(Object.entries(layout.codexHookScripts ?? {}).filter(([name]) => !name.startsWith('_')))
const plugins = Object.fromEntries(Object.entries(layout.codexPlugins ?? {}).filter(([name]) => !name.startsWith('_')))

// 共通側（aidd-codex）
const shared = [
  'check-branch-pr-status.sh',
  'check-branch-tool-ownership.sh',
  'check-local-main-freshness.sh',
  'check-skip-marker-write.sh',
]
const adapter = 'codex-skip-marker-deny.sh'
const doctor = 'aidd-codex-doctor.sh'
// vkumai 固有側（aidd-codex-vkumai）
const vkumaiHooks = ['check-direct-ddl-execution.sh', 'codex-dependency-change-deny.sh', 'codex-ai-check-track.sh', 'codex-ai-check-suggest.sh']
const vkumaiBody = ['check-dependency-change.sh']

assert.deepEqual(Object.keys(plugins).sort(), ['aidd-codex', 'aidd-codex-vkumai'], 'Codex プラグインは 2 つ')
assert.deepEqual(Object.keys(codex).sort(), [...shared, adapter, doctor, ...vkumaiHooks, ...vkumaiBody].sort(), '共通 6 ファイル + 固有 5 ファイル')
for (const name of Object.keys(codex)) {
  assert.ok(Object.keys(plugins).includes(codex[name]), `${name} の所属 ${codex[name]} は codexPlugins にある`)
  assert.ok(fs.existsSync(path.join(root, 'scripts', name)), `${name} の正本が存在する`)
}
for (const name of [...shared, adapter, doctor]) assert.equal(codex[name], 'aidd-codex', `${name} は共通側`)
for (const name of [...vkumaiHooks, ...vkumaiBody]) assert.equal(codex[name], 'aidd-codex-vkumai', `${name} は固有側`)
for (const name of shared) assert.equal(layout.hookScripts[name], 'aidd-core', `${name} の Claude 所属を維持する`)
for (const name of ['check-direct-ddl-execution.sh', 'check-dependency-change.sh']) assert.equal(layout.hookScripts[name], 'aidd-vkumai', `${name} の Claude 所属（aidd-vkumai）を維持する`)
for (const name of [adapter, 'codex-dependency-change-deny.sh', 'codex-ai-check-track.sh', 'codex-ai-check-suggest.sh']) {
  assert.equal(layout.hookScripts[name], undefined, `Codex 専用の ${name} を Claude 用生成器へ渡さない`)
  assert.equal((layout.supportScriptsUnclassified ?? {})[name], undefined, `配布方針を決めた ${name} は未分類に残さない`)
}
// 版は全プラグインで揃える（生成器も落とすが、宣言の段階で見る）
const versions = new Set([...Object.values(plugins).map(p => p.version), ...Object.values(layout.plugins).map(p => p.version)])
assert.equal(versions.size, 1, `Claude / Codex の全プラグインが同じ版（${[...versions].join(' / ')}）`)

const source = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')))
for (const name of [...shared.slice(0, 3), adapter, ...vkumaiHooks]) {
  assert.ok(source.includes(`/scripts/${name}`), `${name} は Codex の project hook に登録済み`)
}
console.log('Codex 用配布宣言: 2 プラグイン・11 ファイル、既存所属、hook 登録、版の一致を確認')
NODE
