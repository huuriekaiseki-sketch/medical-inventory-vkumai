import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('build-eval-agent-json.mjs', () => {
  let tmpDir

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'build-eval-agent-json-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('YAML frontmatterを取り除いた本文をprompt値として--agents用JSONを出力する', () => {
    const agentMdPath = path.join(tmpDir, 'implementer.md')
    writeFileSync(
      agentMdPath,
      '---\nname: implementer\ndescription: 実装用\nmodel: sonnet\n---\n\nあなたは実装担当です。\n'
    )

    const out = execFileSync('node', [
      path.resolve('scripts/lib/build-eval-agent-json.mjs'),
      agentMdPath,
      'implementer',
    ]).toString()

    const parsed = JSON.parse(out)
    expect(Object.keys(parsed)).toEqual(['implementer'])
    expect(parsed.implementer.description).toBe('eval-workflow-prompts fixture agent')
    expect(parsed.implementer.prompt).toBe('あなたは実装担当です。')
  })

  it('本文にJSONエスケープが必要な文字（引用符・バッククォート・改行）が含まれても正しくエスケープする', () => {
    const agentMdPath = path.join(tmpDir, 'tricky.md')
    const body = 'これは"引用符"と`バッククォート`と\n改行を含む本文です。'
    writeFileSync(agentMdPath, `---\nname: tricky\n---\n\n${body}\n`)

    const out = execFileSync('node', [
      path.resolve('scripts/lib/build-eval-agent-json.mjs'),
      agentMdPath,
      'tricky',
    ]).toString()

    const parsed = JSON.parse(out)
    expect(parsed.tricky.prompt).toBe(body)
  })

  it('存在しないファイルパスを指定するとエラー終了する', () => {
    expect(() =>
      execFileSync('node', [
        path.resolve('scripts/lib/build-eval-agent-json.mjs'),
        path.join(tmpDir, 'does-not-exist.md'),
        'implementer',
      ], { stdio: 'pipe' })
    ).toThrow()
  })
})
