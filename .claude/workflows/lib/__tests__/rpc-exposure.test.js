import { describe, it, expect } from 'vitest'
import { findExposedRpcWithoutBoundaryTest } from '../constraint-coverage.js'

// WHY: issue #757 の 34（未テスト経路の自動検出、RPC 軸）。判定の要は「migration を適用順に読み、
//      PostgreSQL の既定（EXECUTE は PUBLIC に付く）と GRANT / REVOKE / DROP を正しく畳み込むこと」。
//      ここが緩むと「呼べるのに列挙されない」= 見逃す方向に壊れるので、RED 方向のケースを固定する。

const fn = (name, extra = '') =>
  `CREATE OR REPLACE FUNCTION ${name}(p_id UUID) RETURNS BOOLEAN LANGUAGE plpgsql ${extra} AS $$ BEGIN RETURN TRUE; END; $$;`

const run = (migrations, boundaryTestSource = '', options = {}) =>
  findExposedRpcWithoutBoundaryTest({ migrations, boundaryTestSource, ...options })

// 約束カタログ（docs/agents/promise-catalog.md）: P-043 クライアントから呼べる RPC は境界テストに登場する
describe('findExposedRpcWithoutBoundaryTest [P-043]', () => {
  it('GRANT を書いていない関数は PostgreSQL 既定の PUBLIC 権限で「呼べる」と判定する', () => {
    const r = run([{ name: '001.sql', sql: fn('is_member') }])
    expect(r.exposed).toEqual(['is_member'])
    expect(r.functions[0].exposedVia[0]).toMatch(/^PUBLIC/)
    expect(r.uncovered.map((u) => u.name)).toEqual(['is_member'])
  })

  it('REVOKE ... FROM PUBLIC, anon, authenticated で service_role だけに絞れば対象外になる', () => {
    const sql = `${fn('record_drift')}
      REVOKE ALL ON FUNCTION record_drift(UUID) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION record_drift(UUID) TO service_role;`
    const r = run([{ name: '001.sql', sql }])
    expect(r.exposed).toEqual([])
    expect(r.functions[0].exposedVia).toEqual([])
  })

  it('REVOKE FROM PUBLIC の後に authenticated へ GRANT すれば authenticated 経由で呼べる', () => {
    const sql = `${fn('get_status')}
      REVOKE ALL ON FUNCTION get_status(UUID) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION get_status(UUID) TO authenticated, service_role;`
    const r = run([{ name: '001.sql', sql }])
    expect(r.functions[0].exposedVia).toEqual(['authenticated'])
  })

  it('authenticated から REVOKE しても PUBLIC 既定が残っていれば呼べる（PUBLIC は全ロールに効く）', () => {
    // WHY: REVOKE ... FROM authenticated だけ書いて安心する誤りを検知する
    const sql = `${fn('leaky')} REVOKE EXECUTE ON FUNCTION leaky(UUID) FROM authenticated;`
    const r = run([{ name: '001.sql', sql }])
    expect(r.exposed).toEqual(['leaky'])
  })

  it('DROP FUNCTION → 再 CREATE で権限は既定（PUBLIC）に戻る（同一ファイル内の順序を守る）', () => {
    // WHY: get_admin_status の修正 migration がこの形。CREATE を先に集めて DROP を後で処理すると
    //      「消えた」と誤判定し、列挙から漏れる（初回実装で実際に起きた）
    const first = `${fn('get_admin_status')}
      REVOKE ALL ON FUNCTION get_admin_status(UUID) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION get_admin_status(UUID) TO authenticated;`
    const second = `DROP FUNCTION IF EXISTS get_admin_status(UUID);
      CREATE OR REPLACE FUNCTION get_admin_status() RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$ SELECT TRUE $$;`
    const r = run([
      { name: '001.sql', sql: first },
      { name: '002.sql', sql: second },
    ])
    expect(r.functions).toHaveLength(1)
    expect(r.functions[0].definedIn).toBe('002.sql')
    expect(r.functions[0].exposedVia[0]).toMatch(/^PUBLIC/)
    expect(r.functions[0].securityDefiner).toBe(true)
  })

  it('CREATE OR REPLACE は権限を維持する', () => {
    const first = `${fn('f')} REVOKE ALL ON FUNCTION f(UUID) FROM PUBLIC;`
    const r = run([
      { name: '001.sql', sql: first },
      { name: '002.sql', sql: fn('f', 'SECURITY DEFINER') },
    ])
    expect(r.exposed).toEqual([])
    expect(r.functions[0].securityDefiner).toBe(true)
  })

  it('RETURNS trigger / event_trigger と public 以外のスキーマは RPC として呼べないので対象外', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE OR REPLACE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END; $$;
      CREATE OR REPLACE FUNCTION auth.internal_thing() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      ${fn('public.visible')}`
    const r = run([{ name: '001.sql', sql }])
    expect(r.functions.map((f) => f.name)).toEqual(['visible'])
  })

  it('境界テストで .rpc(name) を呼んでいれば uncovered にしない（コメントでの言及は数えない）', () => {
    const r = run(
      [{ name: '001.sql', sql: `${fn('is_member')} ${fn('other')}` }],
      `// other は後で
       const { data } = await supabase.rpc('is_member', { p_id: facilityAId })`,
    )
    expect(r.uncovered.map((u) => u.name)).toEqual(['other'])
  })

  it('コメント中の GRANT / CREATE は無視する', () => {
    const sql = `-- GRANT EXECUTE ON FUNCTION ghost(UUID) TO anon;
      /* CREATE FUNCTION ghost2() RETURNS void AS $$ $$; */
      ${fn('real')}`
    const r = run([{ name: '001.sql', sql }])
    expect(r.functions.map((f) => f.name)).toEqual(['real'])
  })

  it('risk は SECURITY DEFINER なら high、アプリが呼ぶか anon から呼べれば medium、それ以外 low', () => {
    const sql = `${fn('a', 'SECURITY DEFINER')} ${fn('b')} ${fn('c')} ${fn('d')}
      GRANT EXECUTE ON FUNCTION d(UUID) TO anon;`
    const r = run([{ name: '001.sql', sql }], '', { appSource: "supabase.rpc('b', {})" })
    const risk = Object.fromEntries(r.uncovered.map((u) => [u.name, u.risk]))
    expect(risk).toEqual({ a: 'high', b: 'medium', c: 'low', d: 'medium' })
  })

  it('notRequired に載せた関数は uncovered から外れるが exposed には残る', () => {
    const r = run([{ name: '001.sql', sql: fn('pub') }], '', { notRequired: ['pub'] })
    expect(r.exposed).toEqual(['pub'])
    expect(r.uncovered).toEqual([])
  })

  it('解釈しない一括権限構文を使ったファイルを unsupported として報告する', () => {
    const sql = `${fn('x')} GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;`
    const r = run([{ name: '009.sql', sql }])
    expect(r.unsupported).toEqual(['009.sql: ON ALL FUNCTIONS IN SCHEMA / ALTER DEFAULT PRIVILEGES は解釈していない'])
  })
})
