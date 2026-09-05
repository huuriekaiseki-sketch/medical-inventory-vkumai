import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// ---- issue #719: 本文の同期（ファイル一覧の一致だけでは Codex 側ミラーの陳腐化を検知できなかった） ----
//
// WHY: 2026-09-05、.agents/skills/handoff-format/SKILL.md が Claude 側より古く、「依存の変更」
// （PR #705/#706）・「promise-catalog」（PR③）・「04 表の 4 値規約」（PR #695/#703）が欠けていた。
// 上のテストはファイル一覧しか見ていないため検知されなかった。スキルごとに「一致すべき単位」を
// 宣言する: Claude 固有の記法（design スキル・${CLAUDE_SKILL_DIR}・allowed-tools）を含まない
// スキルは本文完全一致、含むスキルは見出し（## 以上）の集合一致に留める
// （docs/agents/tooling-decisions.md「ツール中立の共有資産」）。

const SYNC_POLICY: Record<string, 'exact' | 'headings'> = {
  'handoff-format': 'exact',
  'structured-review': 'exact',
  'feature-spec': 'headings', // design スキル依存部分を Codex 向けに書き換えている（意図的差分）
  'e2e-runner': 'headings', // ${CLAUDE_SKILL_DIR} / allowed-tools が Claude 固有（意図的差分）
}

// Stop hook（scripts/check-handoff-format.sh）が PR 本文で検知する見出し・4 値。両ミラーに無いと
// Codex 側で書いた引き継ぎメモが Claude 側の hook に引っかかる
const HANDOFF_REQUIRED_PHRASES = ['30秒サマリー', 'どう確認したか', '依存の変更', '✅ 実施', '➖ 今回不要', '🟡 一部', '⬜ 未実施']

const headings = (text: string) =>
  text.split('\n').filter(l => /^#{1,6}\s/.test(l)).map(l => l.trim()).sort()

describe('.claude/skills/ と .agents/skills/ の本文同期(issue #719)', () => {
  const skillDirs = readdirSync(CLAUDE_SKILLS_DIR).filter(d => statSync(path.join(CLAUDE_SKILLS_DIR, d)).isDirectory())

  it('全スキルが SYNC_POLICY に登録されている（新スキルを足したら同期単位も決める）', () => {
    expect(skillDirs.sort()).toEqual(Object.keys(SYNC_POLICY).sort())
  })

  for (const [skill, policy] of Object.entries(SYNC_POLICY)) {
    const claude = () => readFileSync(path.join(CLAUDE_SKILLS_DIR, skill, 'SKILL.md'), 'utf8')
    const agents = () => readFileSync(path.join(AGENTS_SKILLS_DIR, skill, 'SKILL.md'), 'utf8')
    if (policy === 'exact') {
      it(`${skill}: 本文が完全一致する`, () => {
        expect(agents()).toBe(claude())
      })
    } else {
      it(`${skill}: 見出し（## 以上）の集合が一致する（本文は意図的差分を許容）`, () => {
        expect(headings(agents())).toEqual(headings(claude()))
      })
    }
  }

  it('handoff-format: Stop hook が検知する見出し・4 値が両ミラーにある', () => {
    for (const dir of [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) {
      const text = readFileSync(path.join(dir, 'handoff-format', 'SKILL.md'), 'utf8')
      for (const phrase of HANDOFF_REQUIRED_PHRASES) {
        expect(text, `${dir}: ${phrase}`).toContain(phrase)
      }
    }
  })

  it('RED 方向: 片方から「依存の変更」を消すと検知する（自己検証）', () => {
    const text = readFileSync(path.join(CLAUDE_SKILLS_DIR, 'handoff-format', 'SKILL.md'), 'utf8')
    const tampered = text.replaceAll('依存の変更', '依存の変化')
    expect(tampered).not.toBe(text)
    expect(tampered).not.toContain('依存の変更')
  })
})
