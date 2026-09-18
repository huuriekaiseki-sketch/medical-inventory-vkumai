import { describe, it, expect } from 'vitest'
import { computeDone } from '../phase2-done.js'

const pass = { status: 'pass', detail: 'ok' }
const fail = { status: 'fail', detail: 'ng' }
const blocked = { status: 'blocked', detail: 'blocked' }

const implAllPass = [pass, pass, pass, pass, pass]

// 「差し戻しは起きず、統合ゲートの結果は最新」という既定の証拠。
// lastRetryResult: null は「差し戻しが一度も起きなかった」の明示（undefinedは未申告扱い）。
const fresh = { integrationFresh: true, lastRetryResult: null }

describe('computeDone', () => {
  it('全条件がpassならtrue', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, fresh)).toBe(true)
  })

  it('implResultsに1件でもfailがあればfalse', () => {
    const implWithFail = [pass, pass, fail, pass, pass]
    expect(computeDone(implWithFail, pass, [pass, pass, pass, pass], pass, fresh)).toBe(false)
  })

  it('implResultsに1件でもblockedがあればfalse', () => {
    const implWithBlocked = [pass, blocked, pass, pass, pass]
    expect(computeDone(implWithBlocked, pass, [pass, pass, pass, pass], pass, fresh)).toBe(false)
  })

  it('integrationResult(test/lint/tsc)がpassでなければfalse', () => {
    expect(computeDone(implAllPass, fail, [pass, pass, pass, pass], pass, fresh)).toBe(false)
  })

  it('reviewResultsに1件でもfail(critical/high相当)があればfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, fail, pass, pass], pass, fresh)).toBe(false)
  })

  it('manifestCheck(specHash突合)がpassでなければfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], blocked, fresh)).toBe(false)
  })

  it('manifestCheckが未指定(null/undefined)でもエラーにならずfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], null, fresh)).toBe(false)
  })

  it('implResults/reviewResultsが空配列ならfalse（判定対象が無いのに完了扱いしない）', () => {
    expect(computeDone([], pass, [pass], pass, fresh)).toBe(false)
    expect(computeDone(implAllPass, pass, [], pass, fresh)).toBe(false)
  })

  it('implResultsにfindings全件minorのfailが混ざっていてもtrue（軽微な指摘のみは完了扱い）', () => {
    const minorOnlyFail = { status: 'fail', findings: [{ severity: 'minor', description: '軽微' }] }
    const implWithMinorFail = [pass, minorOnlyFail, pass, pass, pass]
    expect(computeDone(implWithMinorFail, pass, [pass, pass, pass, pass], pass, fresh)).toBe(true)
  })

  it('reviewResultsにfindings全件minorのfailが混ざっていてもtrue（軽微な指摘のみは完了扱い）', () => {
    const minorOnlyFail = { status: 'fail', findings: [{ severity: 'minor', description: '軽微' }] }
    expect(computeDone(implAllPass, pass, [pass, minorOnlyFail, pass, pass], pass, fresh)).toBe(true)
  })

  it('implResultsにfindingsでimportantが混ざるfailがあればfalse（従来通りブロック）', () => {
    const importantFail = { status: 'fail', findings: [{ severity: 'important', description: '重要' }] }
    const implWithImportantFail = [pass, importantFail, pass, pass, pass]
    expect(computeDone(implWithImportantFail, pass, [pass, pass, pass, pass], pass, fresh)).toBe(false)
  })

  // ── 証拠の鮮度（issue R01）──────────────────────────────────────────
  // 「緑だった」という事実だけでは足りず、**どの木に対して**緑だったかが要る。
  // Review差し戻しでコードが変わった後は、変更前に取った統合ゲートの結果を合格に使えない。
  describe('証拠の鮮度(issue R01)', () => {
    it('修正がblockedならfalse（直せていないのに次へ進まない）', () => {
      const evidence = { integrationFresh: true, lastRetryResult: blocked }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })

    it('修正がfail（解決できない指摘が残る）ならfalse', () => {
      const evidence = { integrationFresh: true, lastRetryResult: fail }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })

    it('修正で型エラーが入り統合ゲート再実行がfailならfalse', () => {
      // integrationResult は「取り直した結果」で上書きされる想定。取り直してfailならDONEにしない。
      const evidence = { integrationFresh: true, lastRetryResult: pass }
      expect(computeDone(implAllPass, fail, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })

    it('修正中にSPEC.mdが変わり統合ゲート再実行がblockedならfalse', () => {
      // specHash不一致は再実行エージェントがblockedで返す（aidd-phase2.jsのintegration-recheck）
      const evidence = { integrationFresh: true, lastRetryResult: pass }
      expect(computeDone(implAllPass, blocked, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })

    it('修正後にレビューだけ再実行し統合ゲートを取り直していなければfalse', () => {
      const evidence = { integrationFresh: false, lastRetryResult: pass }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })

    it('修正が入っても統合ゲートを取り直してpassしていればtrue', () => {
      const evidence = { integrationFresh: true, lastRetryResult: pass }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(true)
    })

    it('修正がfindings全件minorのfailなら受け入れる（差し戻し判定と同じ重大度基準）', () => {
      const minorOnlyFail = { status: 'fail', findings: [{ severity: 'minor', description: '軽微' }] }
      const evidence = { integrationFresh: true, lastRetryResult: minorOnlyFail }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(true)
    })

    it('鮮度がまったく申告されていなければfalse（deny-by-default）', () => {
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, undefined)).toBe(false)
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, {})).toBe(false)
    })

    it('integrationFreshがtrueでもlastRetryResultが未申告ならfalse（片方だけの申告を通さない）', () => {
      const evidence = { integrationFresh: true }
      expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass, evidence)).toBe(false)
    })
  })
})
