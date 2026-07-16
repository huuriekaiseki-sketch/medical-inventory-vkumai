#!/usr/bin/env node
// eval-workflow-prompts.shが`claude -p --setting-sources ""`でカスタムagent型(implementer等)を
// 呼び出す際、--setting-sources ""が.claude/agents/*.mdのファイル探索も同時に無効化してしまい
// `--agent 'implementer' not found`で失敗する(issue #391で実機確認)。回避策として、
// .claude/agents/<agentType>.mdのYAML frontmatterを除いた本文を`--agents`フラグ用のJSONに
// 変換し、agent定義を明示的に注入できるようにするCLIラッパー。
import { readFileSync } from 'node:fs'

const [, , agentMdPath, agentType] = process.argv

if (!agentMdPath || !agentType) {
  console.error('usage: build-eval-agent-json.mjs <agentMdPath> <agentType>')
  process.exit(1)
}

let raw
try {
  raw = readFileSync(agentMdPath, 'utf8')
} catch (err) {
  console.error(`build-eval-agent-json: failed to read ${agentMdPath}: ${err.message}`)
  process.exit(1)
}

// YAML frontmatter(先頭の `---\n...\n---\n` ブロック)を取り除き、本文（システムプロンプト）
// だけを抽出する。frontmatterの形式に合致しない場合はファイル全体を本文として扱う
// (クラッシュさせず、呼び出し元のエージェント実行失敗としてエラーが表面化する方針に揃える)。
const frontmatterMatch = raw.match(/^---\n[\s\S]*?\n---\n/)
const body = (frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw).trim()

const agentsJson = {
  [agentType]: {
    description: 'eval-workflow-prompts fixture agent',
    prompt: body,
  },
}

process.stdout.write(JSON.stringify(agentsJson))
