import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PHASE1_FILE = path.resolve(__dirname, '../../aidd-phase1.js')
const DEEP_TASK_FILE = path.resolve(__dirname, '../../aidd-1-1-deep-task.js')
const LIB_FILE = path.resolve(__dirname, '../prompts/sweep.js')
// STATUS_GUIDE/SWEEP_GUIDEにのみ登場する文字列。
const CONTENT_MARKER = '調査を最後まで実行できた'

describe('sweepプロンプトの出力形式ガイドの同期(issue #431)', () => {
  it('aidd-phase1.js内のSTATUS_GUIDEがlib/prompts/sweep.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(PHASE1_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowGuide = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libGuide = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowGuide).toBe(libGuide)
  })

  it('aidd-1-1-deep-task.js内のSWEEP_GUIDEがlib/prompts/sweep.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(DEEP_TASK_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowGuide = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libGuide = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowGuide).toBe(libGuide)
  })
})
