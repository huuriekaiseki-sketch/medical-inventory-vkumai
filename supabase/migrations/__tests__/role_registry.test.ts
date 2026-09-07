import { describe, it, expect } from 'vitest'
import {
  adminRolesFromSql,
  rolesFromCheckConstraint,
  rolesFromTypeScript,
  writerRolesFromSql,
  writerRolesFromUi,
} from '../../__tests__/helpers/role-facts'
import { ROLE_REGISTRY } from '../../__tests__/helpers/role-registry'

// WHY: issue #757 の 27 の続き。「どのロールが何をできるか」は 4 か所に別々に書いてあり、
//      互いに一致しているかを誰も見ていなかった（viewer 追加時に TypeScript 側の更新漏れで
//      誤表示が 2 回起きている）。さらに新しいロールを足しても、そのロールを測るテストは
//      1 本も増えなかった。**4 つ目のロールがすり抜ける**とはこの状態を指す。
//
//      正本は docs/agents/role-rulebook.md（R-xxx）1 枚。ここは宣言と実態を
//      **両方向で**突き合わせるだけ。実 DB での実測は
//      supabase/__tests__/integration/role-capabilities.integration.test.ts が行う。
//
//      4 つとも許可リスト（載っていないロールは何もできない）なので、宣言を書き忘れても
//      権限が勝手に生えることは無い。落ちるのは常に安全側。

const sorted = (xs: string[]) => [...xs].sort()

// 約束カタログ（docs/agents/promise-catalog.md）: P-020 viewer は閲覧のみ / P-021 マスタは admin だけ
describe('施設ロールの決めごとが 4 か所と一致する [P-020 P-021]', () => {
  const registry = ROLE_REGISTRY
  const declared = sorted(Object.keys(registry))

  it('走査そのものが壊れていない（壊れると全件素通りして「合格」に見える）', () => {
    // fail-open 防止。どれか 1 つでも空を返したら、突合が意味を失う
    expect(rolesFromCheckConstraint().length).toBeGreaterThanOrEqual(3)
    expect(rolesFromTypeScript().length).toBeGreaterThanOrEqual(3)
    expect(writerRolesFromSql().length).toBeGreaterThan(0)
    expect(adminRolesFromSql().length).toBeGreaterThan(0)
    expect(writerRolesFromUi().length).toBeGreaterThan(0)
  })

  it('DB の CHECK が受け付けるロールと宣言が一致する（新しいロールはここで必ず止まる）', () => {
    expect(sorted(rolesFromCheckConstraint())).toEqual(declared)
  })

  it('TypeScript の FACILITY_ROLES と宣言が一致する', () => {
    // viewer 追加時にここが漏れて誤表示が 2 回起きた（src/types/role.ts の WHY）
    expect(sorted(rolesFromTypeScript())).toEqual(declared)
  })

  it('is_facility_writer() の許可リストが「施設の行を書く」の宣言と一致する', () => {
    const expected = sorted(
      Object.values(registry)
        .filter((r) => r.writes)
        .map((r) => r.role),
    )
    expect(sorted(writerRolesFromSql())).toEqual(expected)
  })

  it('is_admin() の許可リストが「マスタを書く」の宣言と一致する', () => {
    const expected = sorted(
      Object.values(registry)
        .filter((r) => r.admin)
        .map((r) => r.role),
    )
    expect(sorted(adminRolesFromSql())).toEqual(expected)
  })

  it('画面の canWrite が「画面の書き込み UI」の宣言と一致する', () => {
    const expected = sorted(
      Object.values(registry)
        .filter((r) => r.ui)
        .map((r) => r.role),
    )
    expect(sorted(writerRolesFromUi())).toEqual(expected)
  })

  it('画面が書き込み UI を出すロールは、DB でも書けるロールである', () => {
    // WHY: 画面だけ許して DB が拒否すると「押せるのに失敗する」ボタンになる。
    //      逆（DB で書けるのに UI が出ない）は安全側なので許す（意図的に隠す場合がある）。
    const uiOnly = Object.values(registry)
      .filter((r) => r.ui && !r.writes)
      .map((r) => `${r.id}（${r.role}）: 画面は書けるのに DB では書けない`)
    expect(uiOnly).toEqual([])
  })

  it('実装済みのロールには守るテストがある', () => {
    const missing = Object.values(registry)
      .filter((r) => r.status === '実装済み' && r.guardedBy.length === 0)
      .map((r) => `${r.id}（${r.role}）: 実装済みなのに守るテストが無い`)
    expect(missing).toEqual([])
  })
})
