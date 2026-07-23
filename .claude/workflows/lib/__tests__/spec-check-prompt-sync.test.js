import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../prompts/spec-check.js')
// Spec Checkプロンプトにのみ登場する文字列（issue #507で除外指示から具体例を排除した後の
// 文言）。他のagent()呼び出しのテンプレートリテラルと誤って一致しないよう選ぶ。
const CONTENT_MARKER = '他の場所に同じファイル名の別ファイルが見つかったとしても'
// guide()ヘルパーの本文にのみ登場する文字列（db-implのworkflow-prompt-sync.test.jsと同一
// マーカー。aidd-phase2.js内でguideは1箇所のみ定義され全プロンプトから共有されるため、
// マーカーが同じでも問題なく同一のguide定義を指す）。
const GUIDE_CONTENT_MARKER = 'fail-open防止'

describe('Spec Checkプロンプトの同期(issue #507)', () => {
  it('aidd-phase2.js内のインライン複製がlib/prompts/spec-check.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libTemplate = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowTemplate).toBe(libTemplate)
  })

  it('guide()ヘルパーの本文がaidd-phase2.jsとlib/prompts/spec-check.jsで一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowGuide = extractTemplateLiteralContaining(workflowSource, GUIDE_CONTENT_MARKER)
    const libGuide = extractTemplateLiteralContaining(libSource, GUIDE_CONTENT_MARKER)

    expect(workflowGuide).toBe(libGuide)
  })
})
