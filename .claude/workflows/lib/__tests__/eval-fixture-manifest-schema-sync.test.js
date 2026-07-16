import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const MANIFEST_FILE = path.resolve(__dirname, '../../../../scripts/eval-fixtures/db-impl/manifest.json')

// aidd-phase2.js内のAGENT_RESULT_SCHEMAは、テンプレートリテラル(バッククォート)ではなく
// 通常のJSオブジェクトリテラルのため、extract-template-literal.jsのextractTemplateLiteralContaining
// (バッククォート専用)は使えない。宣言位置から波括弧の対応を数えるだけの、目的特化の
// 最小限の抽出ロジックをここに用意する。
// 前提: AGENT_RESULT_SCHEMAは関数・テンプレートリテラル・外部参照を含まない、純粋な
// JSON互換のオブジェクトリテラルであること(現状のaidd-phase2.js実装を読んで確認済み)。
// この前提が崩れる変更(例: 動的に組み立てるロジックへの変更)が入った場合はこの抽出ロジックも
// 見直しが必要になる。
function extractObjectLiteralSource(sourceText, declarationMarker) {
  const declIndex = sourceText.indexOf(declarationMarker)
  if (declIndex === -1) {
    throw new Error(`extractObjectLiteralSource: declaration marker not found: ${declarationMarker}`)
  }
  const braceStart = sourceText.indexOf('{', declIndex)
  if (braceStart === -1) {
    throw new Error(`extractObjectLiteralSource: no opening brace after marker: ${declarationMarker}`)
  }
  let depth = 0
  let i = braceStart
  for (; i < sourceText.length; i++) {
    if (sourceText[i] === '{') depth++
    else if (sourceText[i] === '}') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  return sourceText.slice(braceStart, i)
}

describe('eval fixture manifest.jsonのjsonSchemaとAGENT_RESULT_SCHEMAの同期(issue #391最終レビュー指摘2)', () => {
  it('scripts/eval-fixtures/db-impl/manifest.jsonのjsonSchemaがaidd-phase2.jsのAGENT_RESULT_SCHEMAと構造的に一致する', () => {
    const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
    const schemaSource = extractObjectLiteralSource(workflowSource, 'const AGENT_RESULT_SCHEMA = ')
    // AGENT_RESULT_SCHEMAはJS構文のオブジェクトリテラル(キーがクォートされていない等)であり
    // JSON.parseできないため、Functionコンストラクタでリテラルとして評価する。関数・外部参照を
    // 含まない前提はファイル先頭のコメントで確認済み。
    // eslint-disable-next-line no-new-func
    const schemaObject = new Function(`return (${schemaSource})`)()

    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'))

    expect(manifest.jsonSchema).toEqual(schemaObject)
  })
})
