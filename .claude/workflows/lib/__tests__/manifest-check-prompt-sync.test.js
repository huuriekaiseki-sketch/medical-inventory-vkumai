import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

// WHY(2026-09-11): Spec Check には 2026-07 から同期テストがあったのに、**Manifest Check には
//      無かった**。`lib/manifest-check.js` は判定表を純粋関数として持つだけでプロンプト文言は持たず、
//      同ファイル自身が「プロンプト文言を変更した場合、このファイルとテストも手動で追従させる
//      必要がある（自動では同期されない）」と書いていた——**穴があることは分かっていて、
//      隣に開けた門を広げていなかった**（docs/agents/check-design-pitfalls.md の C-047）。
//      Manifest Check は deny-by-default のゲートで、黙って緩むと「承認記録が無い」
//      「specHash 不一致」を通してしまう。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../prompts/manifest-check.js')
// Manifest Checkプロンプトにのみ登場する文字列。他のagent()呼び出しのテンプレートリテラルと
// 誤って一致しないよう選ぶ（一意であることは下のテストで実測する）。
const CONTENT_MARKER = '.aidd/run-manifest.json を Read ツールで読んでください'
// guide()ヘルパーの本文にのみ登場する文字列（spec-check-prompt-sync.test.js と同一マーカー。
// aidd-phase2.js内でguideは1箇所のみ定義され全プロンプトから共有される）。
const GUIDE_CONTENT_MARKER = 'fail-open防止'

describe('Manifest Checkプロンプトの同期', () => {
  it('aidd-phase2.js内のインライン複製がlib/prompts/manifest-check.jsの正本と一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const libTemplate = extractTemplateLiteralContaining(libSource, CONTENT_MARKER)

    expect(workflowTemplate).toBe(libTemplate)
  })

  it('guide()ヘルパーの本文がaidd-phase2.jsとlib/prompts/manifest-check.jsで一字一句一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')

    const workflowGuide = extractTemplateLiteralContaining(workflowSource, GUIDE_CONTENT_MARKER)
    const libGuide = extractTemplateLiteralContaining(libSource, GUIDE_CONTENT_MARKER)

    expect(workflowGuide).toBe(libGuide)
  })

  // WHY(C-040): マーカーが 2 つのリテラルに当たると、**別のプロンプトを比べて緑になる**。
  //      「一致した」が「正しいものを比べた」を意味するように、一意であることを別に測る。
  it('マーカーがaidd-phase2.js内で一意（別のプロンプトと取り違えていない）', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const occurrences = workflowSource.split(CONTENT_MARKER).length - 1
    expect(occurrences).toBe(1)
  })

  // WHY(C-022): 片方を変えたら落ちることを確かめないと、「一致した」が「見ていない」と
  //      区別できない。実ファイルは触らず、読み込んだ文字列の上で 1 文字だけ壊して測る。
  it('片方の文言が変わったら落ちる（RED方向の自己検証）', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const libSource = readFileSync(LIB_FILE, 'utf-8')
    const tampered = libSource.replace('blocked。detailに「Run Manifestが存在しません」', 'pass。detailに「Run Manifestが存在しません」')
    expect(tampered).not.toBe(libSource) // 壊せていること自体を先に確かめる（空振り防止）

    const workflowTemplate = extractTemplateLiteralContaining(workflowSource, CONTENT_MARKER)
    const tamperedTemplate = extractTemplateLiteralContaining(tampered, CONTENT_MARKER)
    expect(tamperedTemplate).not.toBe(workflowTemplate)
  })
})
