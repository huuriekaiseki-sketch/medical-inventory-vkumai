import { describe, it, expect } from 'vitest'
import { isBudgetExhausted, isDefaultCapExceeded, shouldContinueLoop } from '../budget-guard.js'

const MIN_REMAINING = 400_000

describe('isBudgetExhausted', () => {
  it('budget.totalが未設定(null)なら常にfalse（予算指定なし=無制限）', () => {
    expect(isBudgetExhausted({ budget: { total: null, remaining: () => 0 }, minRemainingForRound: MIN_REMAINING })).toBe(false)
  })

  it('budgetそのものが渡されない(undefined)場合も常にfalse', () => {
    expect(isBudgetExhausted({ budget: undefined, minRemainingForRound: MIN_REMAINING })).toBe(false)
  })

  it('budget.totalが設定されておりremaining()が閾値以上ならfalse', () => {
    const budget = { total: 1_000_000, remaining: () => 500_000 }
    expect(isBudgetExhausted({ budget, minRemainingForRound: MIN_REMAINING })).toBe(false)
  })

  it('budget.totalが設定されておりremaining()が閾値未満ならtrue', () => {
    const budget = { total: 1_000_000, remaining: () => 100_000 }
    expect(isBudgetExhausted({ budget, minRemainingForRound: MIN_REMAINING })).toBe(true)
  })

  it('remaining()がちょうど閾値と同値ならfalse(境界は消費側に倒す)', () => {
    const budget = { total: 1_000_000, remaining: () => MIN_REMAINING }
    expect(isBudgetExhausted({ budget, minRemainingForRound: MIN_REMAINING })).toBe(false)
  })
})

describe('isDefaultCapExceeded', () => {
  const CAP = 2_000_000

  it('budgetそのものが渡されない(undefined)場合はfalse（判定不能時はfail-openで既存動作維持）', () => {
    expect(isDefaultCapExceeded(undefined, CAP)).toBe(false)
  })

  it('budget.spentが関数でない場合はfalse（Workflowツール外での誤用ガード）', () => {
    expect(isDefaultCapExceeded({ total: null }, CAP)).toBe(false)
  })

  it('budget.totalが設定されている場合はfalse（明示予算はWorkflowツール本体がハード強制する）', () => {
    const budget = { total: 500_000, spent: () => 10_000_000 }
    expect(isDefaultCapExceeded(budget, CAP)).toBe(false)
  })

  it('total未設定でspent()がdefaultCap未満ならfalse', () => {
    const budget = { total: null, spent: () => CAP - 1 }
    expect(isDefaultCapExceeded(budget, CAP)).toBe(false)
  })

  it('total未設定でspent()がちょうどdefaultCapと同値ならtrue（境界は停止側に倒す）', () => {
    const budget = { total: null, spent: () => CAP }
    expect(isDefaultCapExceeded(budget, CAP)).toBe(true)
  })

  it('total未設定でspent()がdefaultCap超過ならtrue', () => {
    const budget = { total: null, spent: () => CAP + 1 }
    expect(isDefaultCapExceeded(budget, CAP)).toBe(true)
  })
})

describe('shouldContinueLoop', () => {
  const baseArgs = { dryRounds: 0, round: 1, maxRounds: 3, minRemainingForRound: MIN_REMAINING }

  it('budget未設定なら既存動作どおりdryRounds/maxRoundsのみで継続判定する', () => {
    expect(shouldContinueLoop({ ...baseArgs, budget: { total: null, remaining: () => 0 } })).toBe(true)
  })

  it('dryRoundsが2に達していればbudgetに残高があってもfalse', () => {
    expect(shouldContinueLoop({
      ...baseArgs,
      dryRounds: 2,
      budget: { total: 1_000_000, remaining: () => 1_000_000 },
    })).toBe(false)
  })

  it('roundがmaxRoundsを超えていればbudgetに残高があってもfalse', () => {
    expect(shouldContinueLoop({
      ...baseArgs,
      round: 4,
      budget: { total: 1_000_000, remaining: () => 1_000_000 },
    })).toBe(false)
  })

  it('budgetの残高が閾値未満ならdry/round条件を満たしていてもfalse', () => {
    expect(shouldContinueLoop({
      ...baseArgs,
      budget: { total: 1_000_000, remaining: () => 100_000 },
    })).toBe(false)
  })

  it('budgetの残高が閾値以上でdry/round条件も満たしていればtrue', () => {
    expect(shouldContinueLoop({
      ...baseArgs,
      budget: { total: 1_000_000, remaining: () => 500_000 },
    })).toBe(true)
  })
})
