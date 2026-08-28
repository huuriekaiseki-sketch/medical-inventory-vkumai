import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// WHY: .agents/skills/handoff-format/ が丸ごとコミットされておらず、全worktreeで
// git statusにuntrackedファイルとして表示され続ける不具合があった(PR #676)。
// .claude/skills/ と .agents/skills/ は同じスキル群をClaude/Codex双方に提供する
// ミラー構成（docs/agents/tooling-decisions.md「ツール中立の共有資産」参照）であり、
// 中身は`allowed-tools`等ツール固有の記法差があるため一致しないが、
// 「どのスキルフォルダ・どのファイルが存在するか」は必ず一致するべき不変条件である。
// これはfacility/RLS等のドメインコードではなくリポジトリ衛生のテストなので、
// npm testに含めてCIで機械的に検知する。

const ROOT = path.resolve(__dirname, '../..')
const CLAUDE_SKILLS_DIR = path.join(ROOT, '.claude/skills')
const AGENTS_SKILLS_DIR = path.join(ROOT, '.agents/skills')

function listFilesRelative(baseDir: string): string[] {
  const result: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        result.push(path.relative(baseDir, full))
      }
    }
  }
  walk(baseDir)
  return result.sort()
}

describe('.claude/skills/ と .agents/skills/ のファイル構成一致(issue #676再発防止)', () => {
  const claudeFiles = listFilesRelative(CLAUDE_SKILLS_DIR)
  const agentsFiles = listFilesRelative(AGENTS_SKILLS_DIR)

  it('両ディレクトリのファイル一覧が一致する', () => {
    expect(agentsFiles).toEqual(claudeFiles)
  })
})
