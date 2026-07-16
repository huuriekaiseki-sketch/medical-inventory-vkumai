import { describe, it, expect } from 'vitest'
import { resolveWorkflowArgs } from '../resolve-workflow-args.js'

describe('resolveWorkflowArgs', () => {
  it('argsがobjectで渡ってきた場合はそのまま返す', () => {
    const args = { taskDescription: '在庫一覧の並び替え', changedFiles: ['src/app/page.tsx'] }
    expect(resolveWorkflowArgs(args)).toBe(args)
  })

  it('argsがJSON文字列で渡ってきた場合はparseして返す（Workflowツール既知の不具合への回避策）', () => {
    const args = JSON.stringify({ taskDescription: '在庫一覧の並び替え', maxRounds: 2 })
    expect(resolveWorkflowArgs(args)).toEqual({ taskDescription: '在庫一覧の並び替え', maxRounds: 2 })
  })

  it('argsがundefinedの場合はundefinedをそのまま返す', () => {
    expect(resolveWorkflowArgs(undefined)).toBeUndefined()
  })
})
