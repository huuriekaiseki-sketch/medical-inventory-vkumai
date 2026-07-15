import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../prompts/db-impl.js')
// db-implプロンプトにのみ登場する文字列。他のagent()呼び出し(contract-writer等)の
// テンプレートリテラルと誤って一致しないことを保証するため、十分に特徴的な一節を選ぶ。
const CONTENT_MARKER = 'Part 2にDBスキーマ変更が不要と明記されている場合'

describe('db-implプロンプトの同期(issue #391)', () => {
  it('aidd-phase2.js内のインライン複製がlib/prompts/db-impl.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libTemplate = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowTemplate).toBe(libTemplate)
  })
})
