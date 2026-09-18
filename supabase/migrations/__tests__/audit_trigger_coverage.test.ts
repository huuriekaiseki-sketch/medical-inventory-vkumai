import { describe, it, expect } from 'vitest'
import {
  auditedTablesFromMigrations,
  readMigration,
  stripComments,
  tablesFromMigrations,
} from '../../__tests__/helpers/table-facts'
import { AUDIT_EXEMPT_TABLES } from '../../__tests__/helpers/table-registry'

// WHY: issue #757 の 24（監査証跡の完全性）。監査ログのトリガーを付ける先は
//      20260906000004_add_audit_log.sql の中の**手書きの配列**で決まっている。
//      新しいテーブルを足した人がその配列に足し忘れても、今は誰も気づかない。
//      実際に main の外で 2 件（access_denials・rate_limit_counters）が
//      「対象にするか外すか」を一度も決めないまま増えていた。
//
//      add_audit_log.test.ts は「配列に 16 個入っているか」を見ているが、それは
//      **同じ一覧をもう 1 か所に書き写しただけ**で、新しいテーブルには反応しない
//      （両方に書き忘れれば両方とも緑のまま）。ここでは向きを逆にして、
//      **migration に存在する全テーブル**を起点に「監査対象か、理由付きで対象外か」を問う。
//
//      対象外の理由の正本は supabase/__tests__/helpers/table-registry.ts
//      （2026-09-07。表を作るときに決める 4 軸を 1 枚にまとめた）。
//
//      「本当に 1 行だけ残るか」は DB が要るので
//      supabase/__tests__/integration/audit-completeness.integration.test.ts が実測する。

// 約束カタログ（docs/agents/promise-catalog.md）: P-060 全経路で残る
describe('監査トリガーの網羅（新しいテーブルが黙って対象外にならない） [P-060]', () => {
  const tables = tablesFromMigrations()
  const audited = auditedTablesFromMigrations()

  it('走査そのものが壊れていない（壊れると全件素通りして「合格」に見える）', () => {
    // fail-open 防止。テーブルもトリガーも 1 件も取れなくなったらここで落ちる
    expect(tables.size).toBeGreaterThanOrEqual(19)
    expect(audited.size).toBeGreaterThanOrEqual(16)
    expect(audited.has('case_orders')).toBe(true)
    expect(audited.has('user_facilities')).toBe(true)
  })

  it('存在する全テーブルは「監査対象」か「理由付きで対象外」のどちらかである', () => {
    const unclassified = [...tables.entries()]
      .filter(([name]) => !audited.has(name) && !(name in AUDIT_EXEMPT_TABLES))
      .map(
        ([name, file]) =>
          `${name}（${file} で追加。監査対象にするか table-registry.ts に理由を書くこと）`,
      )
    expect(unclassified).toEqual([])
  })

  it('対象外リストのテーブルは実在し、監査対象にもなっていない（リスト陳腐化の検知）', () => {
    for (const [name, reason] of Object.entries(AUDIT_EXEMPT_TABLES)) {
      expect(tables.has(name), `${name} は migration に存在しない（リストから消すこと）`).toBe(true)
      expect(audited.has(name), `${name} は監査対象になった（リストから消すこと）`).toBe(false)
      // 「理由」が空・仮置きのまま通らないようにする
      expect(reason.trim().length, `${name} の理由が短すぎる`).toBeGreaterThan(20)
      expect(reason).not.toMatch(/todo|後で|あとで|未定/i)
    }
  })

  it('監査対象の一覧に、存在しないテーブルが混ざっていない', () => {
    expect([...audited].filter((name) => !tables.has(name))).toEqual([])
  })

  it('一括登録のトリガーは AFTER の行トリガーで、3 つの操作すべてを拾う', () => {
    const sql = stripComments(readMigration('20260906000004_add_audit_log.sql'))
    // BEFORE だと後続トリガーの書き換えが残らず、STATEMENT だと行ごとに残らない。
    // 3 つの操作のどれか 1 つでも欠けると「その操作だけ記録されない」取りこぼしになる
    expect(sql).toContain(
      'after insert or update or delete on %i for each row execute function audit_row_change()',
    )
  })
})
