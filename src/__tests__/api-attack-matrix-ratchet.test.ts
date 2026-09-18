import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  discoverRoutes,
  diffAttackMatrix,
  type DiscoveredRoute,
} from '../../e2e/api-route-registry'
import { ATTACK_MATRIX, type RouteAttacks } from '../../e2e/api-attack-matrix'

// WHY(2026-09-10): 約束カタログ P-017（他施設ユーザーによる API 直接攻撃）は
//      「実在する route が 1 本残らず攻撃表に載っている」ことに乗っている。
//      表に無い route は総当たりの対象に入らないので、**攻撃されないまま増える**。
//
//      この突合は元々 `e2e/api-cross-facility-attack.spec.ts` の中にあったが、
//      そこでは事実上ほとんど回っていなかった:
//        - E2E は main マージ後にしか回らない（PR 実行は 2026-08-25 に廃止。E-060）
//        - `test.describe` 直下の `test.skip`（フィクスチャ / SUPABASE_SERVICE_ROLE_KEY）が
//          この突合にも効いていた。**ファイルを読むだけで DB も鍵も要らない検査**なのに、
//          スナップショット比較の都合で Supabase を止めている間ずっとスキップされていた
//
//      実際 2026-09-10 に認可チェックの無い route（`/api/authcheck-probe/[id]`）を
//      実コードへ置いて回帰を回したところ、typecheck / lint / check-operation-contracts /
//      check-access-path-inventory / check-input-validation-coverage /
//      check-query-validation-coverage / check-threat-model の **7 本すべてが通った**。
//      唯一気づけるはずだったこの ratchet が、スキップされていたためである。
//
//      そこで `npm test`（＝毎回・CI の PR でも回る）へ移した。
//      判定は `e2e/api-route-registry.ts` にしかない（E-053: 同じ問いに 2 か所が別々に答えない）。

const appDir = path.join(process.cwd(), 'src', 'app')

describe('攻撃表は実在する route × メソッドと過不足なく対応する [P-017]', () => {
  const routes = discoverRoutes(appDir)

  it('実在する route を 1 本以上見つける（列挙そのものが壊れていない）', () => {
    // 0 本なら「違反 0」も自動的に成り立ってしまう（C-011: パスの実在しか見ない検査の裏返し）。
    // 空を緑と読まないよう、下限を実測値の近くに置く（2026-09-10 実測: 34 本）
    expect(routes.length).toBeGreaterThanOrEqual(30)
  })

  it('実在するのに攻撃表に無い route / 書き込みメソッドが 0 件', () => {
    const { missing } = diffAttackMatrix(routes)
    expect(missing, '新しい route / メソッドを e2e/api-attack-matrix.ts に足す').toEqual([])
  })

  it('攻撃表にあるのに実在しない route / メソッドが 0 件（表の腐敗検知）', () => {
    const { stale } = diffAttackMatrix(routes)
    expect(stale, '消えた route / メソッドを e2e/api-attack-matrix.ts から消す').toEqual([])
  })
})

// WHY(C-022: 壊して落ちることを確かめる): 上の 3 件は「違反 0」を主張するだけなので、
//      判定そのものが壊れていても緑になる。**わざと違反を作って落ちること**を対にして置く。
describe('突合そのものが働いていること（RED 方向の対照）', () => {
  const routes: DiscoveredRoute[] = [
    { route: '/api/things', methods: ['GET', 'POST'] },
    { route: '/api/things/[id]', methods: ['GET', 'DELETE'] },
  ]
  const matrix: Record<string, RouteAttacks> = {
    '/api/things': { POST: { body: {} } },
    '/api/things/[id]': { DELETE: { pathId: 'random' } },
  }

  it('揃っていれば違反 0（対照が緑であること自体を確かめる）', () => {
    expect(diffAttackMatrix(routes, matrix)).toEqual({ missing: [], stale: [] })
  })

  it('表から route を丸ごと落とすと missing が出る', () => {
    const broken = { '/api/things': matrix['/api/things'] }
    const { missing } = diffAttackMatrix(routes, broken)
    expect(missing).toEqual(['/api/things/[id]（表に無い）'])
  })

  it('書き込みメソッドだけ表から落とすと missing が出る', () => {
    const broken: Record<string, RouteAttacks> = { ...matrix, '/api/things': {} }
    const { missing } = diffAttackMatrix(routes, broken)
    expect(missing).toEqual(['/api/things POST（書き込み系は有効な body を表に書く）'])
  })

  it('GET は表に無くても missing にしない（既定の攻撃で足りるため。過検知しないことの対照）', () => {
    const onlyWrites: Record<string, RouteAttacks> = {
      '/api/things': { POST: { body: {} } },
      '/api/things/[id]': { DELETE: {} },
    }
    expect(diffAttackMatrix(routes, onlyWrites).missing).toEqual([])
  })

  it('実在しない route が表にあると stale が出る', () => {
    const broken: Record<string, RouteAttacks> = { ...matrix, '/api/ghost': { POST: { body: {} } } }
    const { stale } = diffAttackMatrix(routes, broken)
    expect(stale).toEqual(['/api/ghost（route.ts が無い）'])
  })

  it('export されていないメソッドが表にあると stale が出る', () => {
    const broken: Record<string, RouteAttacks> = {
      ...matrix,
      '/api/things': { POST: { body: {} }, PUT: { body: {} } },
    }
    const { stale } = diffAttackMatrix(routes, broken)
    expect(stale).toEqual(['/api/things PUT（export されていない）'])
  })
})

// WHY(2026-09-10): 列挙が `route.ts` の `export async function` だけを見ていると、
//      **拡張子や書き方を変えるだけで攻撃表への登録を避けられる**。
//      実測では今のところ全 34 本がその形だが、0 件のうちに道を塞いでおく
//      （検知を賢くするより、間違えられる道を無くす）。
describe('route の列挙に抜け道が無い', () => {
  let tmp: string

  const write = (relDir: string, file: string, source: string) => {
    const dir = path.join(tmp, relDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, file), source, 'utf-8')
  }

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-registry-'))
    write('api/async-fn', 'route.ts', 'export async function GET() {}')
    write('api/plain-fn', 'route.ts', 'export function POST() {}')
    write('api/const-arrow', 'route.ts', 'export const PUT = async () => {}')
    write('api/re-export', 'route.ts', 'const h = () => {}\nexport { h as DELETE }')
    write('api/tsx-ext', 'route.tsx', 'export async function PATCH() {}')
    // route ではないファイルは拾わない（過検知しないことの対照）
    write('api/not-a-route', 'helpers.ts', 'export async function GET() {}')
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('4 つの export の書き方と route.tsx をすべて列挙する', () => {
    const found = discoverRoutes(tmp)
    expect(found).toEqual([
      { route: '/api/async-fn', methods: ['GET'] },
      { route: '/api/const-arrow', methods: ['PUT'] },
      { route: '/api/plain-fn', methods: ['POST'] },
      { route: '/api/re-export', methods: ['DELETE'] },
      { route: '/api/tsx-ext', methods: ['PATCH'] },
    ])
  })

  it('route という名前でないファイルは列挙しない', () => {
    expect(discoverRoutes(tmp).map((r) => r.route)).not.toContain('/api/not-a-route')
  })
})

// WHY(2026-09-10): 判定を 1 か所に寄せた意味は、spec 側が**同じ関数を使い続ける**ことで保たれる。
//      spec の中に独自の route 列挙が復活すると、E-053（同じ問いに 2 か所が別々に答える）へ戻る。
describe('攻撃 spec は列挙を自前で持たない（E-053 の再発検知）', () => {
  const specPath = path.join(process.cwd(), 'e2e', 'api-cross-facility-attack.spec.ts')
  const source = fs.readFileSync(specPath, 'utf-8')

  it('共有の列挙を import している', () => {
    expect(source).toMatch(/from '\.\/api-route-registry'/)
  })

  it('spec の中で route.ts を自前で歩いていない', () => {
    expect(source).not.toMatch(/readdirSync/)
  })
})

// 表の内容そのものが空になっていないこと（C-011 の裏返し: 表が消えても上の突合は
// 「実在 route が全部 missing」で落ちるが、逆に route が消えた日に静かに緑にならないよう下限を置く）
describe('攻撃表が空になっていない', () => {
  it('表のキーが 30 件以上ある', () => {
    expect(Object.keys(ATTACK_MATRIX).length).toBeGreaterThanOrEqual(30)
  })
})
