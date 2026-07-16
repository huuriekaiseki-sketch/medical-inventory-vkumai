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
// guide()ヘルパー（"## 出力形式"〜"fail-open防止"）の本文にのみ登場する文字列。
// guide()はaidd-phase2.js側ではcontract-writer/data-impl/api-impl/ui-impl/db-implの
// 複数エージェントプロンプトで共有される関数であり、db-impl.js側ではローカルに複製された
// コピーが使われる。CONTENT_MARKERが指す外側のプロンプト文字列とは別の、もう1つの複製箇所
// （FINDING 1: 最終レビュー指摘）。
const GUIDE_CONTENT_MARKER = 'fail-open防止'

describe('db-implプロンプトの同期(issue #391)', () => {
  it('aidd-phase2.js内のインライン複製がlib/prompts/db-impl.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libTemplate = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowTemplate).toBe(libTemplate)
  })

  it('guide()ヘルパーの本文がaidd-phase2.jsとlib/prompts/db-impl.jsで一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowGuide = extractTemplateLiteralContaining(workflowSource, GUIDE_CONTENT_MARKER)
    const libGuide = extractTemplateLiteralContaining(libSource, GUIDE_CONTENT_MARKER)

    expect(workflowGuide).toBe(libGuide)
  })
})
