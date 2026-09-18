import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { classifyRoute } from '../router-risk.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')

const strykerConfig = JSON.parse(readFileSync(path.join(ROOT, 'stryker.config.json'), 'utf-8'))
const aiddConfig = JSON.parse(readFileSync(path.join(ROOT, 'aidd.config.json'), 'utf-8'))
const riskConfig = aiddConfig.risk

// stryker.config.json の mutate は「認可の判断が書かれている場所」の一覧（同ファイルの
// _comment がそう宣言している）。TRI/RISK 判定はそこを高リスクとして扱えていなければならない。
//
// なぜこの突合が要るか（issue R02）: 2026-09-10 まで、この 2 つの宣言は食い違っていた。
// src/lib/admin-status.ts・src/lib/security/access-denial.ts・src/app/api/admin/users/route.ts
// のような**認可の本体**は、pathPrefixes（supabase 配下の 2 件だけ）にも
// domainKeywords（auth/facility/… をパス文字列に含むか）にも当たらず、
// 「認証と施設分離のルールを変更する」という説明でも light ルートへ落ちていた。
// 片方だけ増やしても気づけないので、機械で対応させる。
describe('認可の実ファイルが高リスクとして扱われる(issue R02)', () => {
  const targets = strykerConfig.mutate ?? []

  it('Stryker の対象一覧が空でない（走査の空振り防止）', () => {
    expect(targets.length).toBeGreaterThan(0)
  })

  for (const file of targets) {
    it(`${file} は deep ルートになる`, () => {
      // 説明文は空にする。パスだけで高リスクと判定できることを見る
      const r = classifyRoute('', [file], riskConfig)
      expect(r.route).toBe('deep')
    })
  }

  it('無関係なファイルは light のまま（この検査が「全部 deep」で通っていないことの対照）', () => {
    const r = classifyRoute('', ['src/components/orders/OrderHistoryTable.tsx'], riskConfig)
    expect(r.route).toBe('light')
  })
})

describe('説明とファイルが食い違うときは確認ルートへ(issue R02)', () => {
  it('ドメイン語のある説明で高リスクパスが1件も無ければ confirm', () => {
    const r = classifyRoute('認証と施設分離のルールを変更する', ['README.md'], riskConfig)
    expect(r.route).toBe('confirm')
    expect(r.confirmReason).toBe('description-path-mismatch')
  })

  it('説明にドメイン語が無ければ従来どおり light（確認を乱発しない）', () => {
    const r = classifyRoute('表の並び順を直す', ['README.md'], riskConfig)
    expect(r.route).toBe('light')
    expect(r.confirmReason).toBe(null)
  })

  it('高リスクパスが1件でもあれば deep（確認を挟まない）', () => {
    const r = classifyRoute('認証のルールを変更する', ['README.md', 'src/lib/security/rate-limit.ts'], riskConfig)
    expect(r.route).toBe('deep')
    expect(r.confirmReason).toBe(null)
  })

  it('changedFiles が空のときの confirm は従来どおり理由が別（issue #500）', () => {
    const r = classifyRoute('認証のルールを変更する', [], riskConfig)
    expect(r.route).toBe('confirm')
    expect(r.confirmReason).toBe('no-changed-files')
  })

  it('メタ改修は説明にドメイン語があっても meta のまま（issue #457 を崩さない）', () => {
    const r = classifyRoute('authには触れない改修', ['.claude/workflows/aidd-phase2.js'], riskConfig)
    expect(r.route).toBe('meta')
  })
})
