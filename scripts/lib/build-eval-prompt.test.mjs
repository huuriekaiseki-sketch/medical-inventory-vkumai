import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('build-eval-prompt.mjs', () => {
  let tmpDir
  let modulePath

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'build-eval-prompt-test-'))
    modulePath = path.join(tmpDir, 'sample-prompt.js')
    writeFileSync(
      modulePath,
      "export function buildSample(specPath) { return `hello ${specPath}` }\n"
    )
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('指定したモジュール・関数・引数でプロンプト文字列を標準出力に書く', () => {
    const out = execFileSync('node', [
      path.resolve('scripts/lib/build-eval-prompt.mjs'),
      modulePath,
      'buildSample',
      'SPEC.md',
    ]).toString()
    expect(out).toBe('hello SPEC.md')
  })

  it('存在しない関数名を指定するとエラー終了する', () => {
    expect(() =>
      execFileSync('node', [
        path.resolve('scripts/lib/build-eval-prompt.mjs'),
        modulePath,
        'notAFunction',
        'SPEC.md',
      ], { stdio: 'pipe' })
    ).toThrow()
  })
})
