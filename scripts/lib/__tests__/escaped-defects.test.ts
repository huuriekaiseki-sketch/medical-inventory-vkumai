import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: 2026-09-07。ルールブックの「限界」が的外れかどうかは書いた時点では分からない。
//      分かるのは検査で漏れが出たときだけなので、その漏れをルールブックへ戻す輪を閉じたい。
//      ところが**実装を直せばテストは緑に戻る**ので、ルールブックを直さないまま終われてしまう。
//      それでは輪が閉じない。
//
//      そこで台帳（docs/agents/escaped-defects.md）の未処理を `npm test` の失敗にする。
//      これで「テストが緑になれば終われる」が文字通り成立しなくなる。
//      hook ではなくテストにするのは、ローカルの `npm test` と CI の両方で機械的に起動するため
//      （constraint_coverage_ratchet.test.ts と同じ理由。docs/agents/actuator-inventory.md）。
//
//      表の**形**（列数・ID・状態の語彙・再発防止のパス実在）は汎用エンジン
//      scripts/lib/check-catalog.mjs が見る。ここは形ではなく**輪が閉じているか**だけを見る。

const LEDGER = path.resolve(__dirname, '../../../docs/agents/escaped-defects.md')

const DISPOSITIONS = ['実装バグ', 'テスト不足', 'ルールブック不足', '環境'] as const
const SOURCES = [
  '3A テスト',
  'DB 制約',
  'RLS',
  '層間突合',
  'ミューテーション',
  '実経路攻撃',
  '人の判断',
  '実運用',
] as const

interface Row {
  id: string
  what: string
  disposition: string
  source: string
  rulebook: string
  decidedBy: string
  fixed: string
  prevention: string
  status: string
}

function loadRows(): Row[] {
  const text = readFileSync(LEDGER, 'utf-8')
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!/^\|\s*E-/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    expect(cells.length, `${cells[0]}: 9 列でない（${cells.length}）`).toBe(9)
    const [id, what, disposition, source, rulebook, decidedBy, fixed, prevention, status] = cells
    rows.push({ id, what, disposition, source, rulebook, decidedBy, fixed, prevention, status })
  }
  return rows
}

describe('取りこぼし台帳: 漏れがルールブックの更新まで閉じないと完了できない', () => {
  const rows = loadRows()

  it('台帳を読めている（読めなくなると全件素通りして「合格」に見える）', () => {
    // fail-open 防止。パーサが壊れて 0 行になったらここで落ちる
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.status === '解決済み')).toBe(true)
  })

  it('未分類の行が 1 つも無い（あると npm test 全体が緑にならない）', () => {
    const unclassified = rows
      .filter((r) => r.status === '未分類' || !DISPOSITIONS.includes(r.disposition as never))
      .map((r) => `${r.id}: 分類「${r.disposition}」/ 状態「${r.status}」 — ${r.what.slice(0, 40)}`)
    expect(unclassified).toEqual([])
  })

  it('検出源が語彙にある（数えられない値を書かせない）', () => {
    const unknown = rows
      .filter((r) => !SOURCES.includes(r.source as never))
      .map((r) => `${r.id}: 「${r.source}」は検出源の語彙にない（${SOURCES.join(' / ')}）`)
    expect(unknown).toEqual([])
  })

  it('「ルールブック不足」の行は、解決済みにする前に必ずルールブックを名指ししている', () => {
    // WHY: これが輪の要。ルールブック不足と分類したのに、どのルールブックを直したか
    //      書かないまま解決済みにできると、実装だけ直して終わる元の形に戻ってしまう。
    const problems = rows
      .filter((r) => r.disposition === 'ルールブック不足' && r.status === '解決済み')
      .filter((r) => r.rulebook === '' || r.rulebook === '未')
      .map((r) => `${r.id}: ルールブック不足なのに関連ルールブックが空`)
    expect(problems).toEqual([])
  })

  it('解決済みの行は「再発防止」に実在するパスを書いている', () => {
    // 直したこと（その場）と再発防止（次から止まる仕組み）は別物。後者が無い解決は対症療法
    const problems: string[] = []
    for (const r of rows.filter((x) => x.status === '解決済み')) {
      const paths = [...r.prevention.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      if (paths.length === 0) {
        problems.push(`${r.id}: 解決済みなのに再発防止のパスが無い（対症療法で終わっていないか）`)
        continue
      }
      for (const p of paths) {
        if (!/\.(ts|tsx|mjs|js|sh|sql|md|json|yml|yaml)$/.test(p)) continue
        const abs = path.resolve(__dirname, '../../..', p)
        try {
          readFileSync(abs)
        } catch {
          problems.push(`${r.id}: 再発防止のパスが存在しない: ${p}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('値を決めた行には決めた人が書いてある（AI だけで決まった箇所を数えられるようにする）', () => {
    const KNOWN = [
      'domain_owner',
      'security_review',
      'product_owner',
      'AI 提案（人が承認）',
      'AI 提案（未承認）',
      '該当なし',
    ]
    const unknown = rows
      .filter((r) => !KNOWN.includes(r.decidedBy))
      .map((r) => `${r.id}: 「${r.decidedBy}」は決定者の語彙にない`)
    expect(unknown).toEqual([])
  })
})
