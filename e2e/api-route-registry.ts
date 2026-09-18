// e2e/api-route-registry.ts
// WHY(2026-09-10): 「実在する route が攻撃表（api-attack-matrix.ts）に載っているか」に
//      答える場所を 1 か所にする。この突合は元々 api-cross-facility-attack.spec.ts の中に
//      あったが、**3 つの理由でほとんど回っていなかった**:
//
//        1. E2E は main マージ後にしか回らない（2026-08-25 に Actions 無料枠の都合で
//           PR 実行を廃止。E-060 で「1 日以上、赤のまま誰にも見られていなかった」実績あり）
//        2. `test.describe` 直下の `test.skip`（cross-facility フィクスチャ /
//           SUPABASE_SERVICE_ROLE_KEY）が **この突合にも効いていた**。
//           突合はファイルを読むだけで DB も鍵も要らないのに、スナップショット比較の
//           都合に巻き込まれて、ローカル（Supabase を止めている間）では常にスキップされる
//        3. 実際 2026-09-10 に「認可チェックの無い route」を実コードへ置いて回帰を回したが、
//           typecheck / lint / check-operation-contracts / check-access-path-inventory /
//           check-input-validation-coverage / check-query-validation-coverage /
//           check-threat-model の **7 本すべてが通った**。誰も捕まえなかった
//
//      そこで突合を依存ゼロの純粋関数として切り出し、**`npm test`（vitest）が毎回**
//      答えるようにした（`src/__tests__/api-attack-matrix-ratchet.test.ts`）。
//      E-053（同じ問いに 2 か所が別々に答える）を避けるため、判定はこのファイルにしかない。
//      spec 側は同じ関数を呼んで攻撃対象を組み立てるだけで、合否は判定しない。

import * as fs from 'fs'
import * as path from 'path'
import { ATTACK_MATRIX, type Method, type RouteAttacks } from './api-attack-matrix'

export const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export interface DiscoveredRoute {
  route: string
  methods: Method[]
}

// WHY(拡張子を route.ts に限定しない、2026-09-10): 2026-09-10 時点の実測では 34 本すべてが
//      `route.ts` だが、**Next.js は route.tsx / route.js / route.jsx でも Route Handler として
//      動かす**。`route.ts` だけを見ていると、拡張子を変えるだけで攻撃表への登録を
//      避けられてしまう（検知を賢くするより、間違えられる道を無くす）。
const ROUTE_FILE = /^route\.(tsx?|jsx?|mjs)$/

// WHY(export の書き方を 1 つに決め打ちしない、2026-09-10): 元の実装は
//      `export async function GET` だけを見ていた。実測では 59 か所すべてがこの形で、
//      他の書き方は 0 件だったが、**`export const GET = ...` でも Next.js は route として動く**。
//      0 件のうちに広げておけば、あとから「たまたま別の書き方をした route」が
//      表に載らないまま増えることがない。
function exportsMethod(source: string, method: Method): boolean {
  const patterns = [
    // export async function GET / export function GET
    `export\\s+(?:async\\s+)?function\\s+${method}\\b`,
    // export const GET = ... / export let GET = ...
    `export\\s+(?:const|let|var)\\s+${method}\\s*[=:]`,
    // export { GET } / export { handler as GET }
    `export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`,
  ]
  return patterns.some((p) => new RegExp(p).test(source))
}

/**
 * `src/app` 配下の Route Handler を列挙し、'/api/loan-orders' や '/api/hospital-prices/[id]'
 * の形にする（動的部分は `[id]` のまま）。
 */
export function discoverRoutes(appDir: string): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!ROUTE_FILE.test(name)) continue
      const rel = path.relative(appDir, path.dirname(p)).split(path.sep).join('/')
      const src = fs.readFileSync(p, 'utf-8')
      const methods = METHODS.filter((m) => exportsMethod(src, m))
      found.push({ route: `/${rel}`, methods })
    }
  }
  walk(appDir)
  return found.sort((a, b) => a.route.localeCompare(b.route))
}

export interface MatrixDiff {
  /** 実在するのに攻撃表に無い（＝攻撃されないまま増えた route） */
  missing: string[]
  /** 攻撃表にあるのに実在しない（＝表が腐っている） */
  stale: string[]
}

/**
 * 実在する route × メソッドと攻撃表を突き合わせる。両方向を見る（片側だけだと腐る）。
 *
 * GET を missing に数えないのは、GET には既定の攻撃（query に施設 A の ID）があり
 * route ごとの body を書かなくても攻撃できるため。書き込み系は有効な body が無いと
 * 入口の検証で 400 になり、認可の判定まで到達しない。
 */
export function diffAttackMatrix(
  routes: DiscoveredRoute[],
  matrix: Record<string, RouteAttacks> = ATTACK_MATRIX,
): MatrixDiff {
  const missing: string[] = []
  for (const { route, methods } of routes) {
    const entry = matrix[route]
    if (!entry) {
      missing.push(`${route}（表に無い）`)
      continue
    }
    for (const m of methods) {
      if (m === 'GET') continue
      if (!entry[m]) missing.push(`${route} ${m}（書き込み系は有効な body を表に書く）`)
    }
  }

  const stale: string[] = []
  for (const route of Object.keys(matrix)) {
    const r = routes.find((x) => x.route === route)
    if (!r) {
      stale.push(`${route}（route.ts が無い）`)
      continue
    }
    for (const m of Object.keys(matrix[route]) as Method[]) {
      if (!r.methods.includes(m)) stale.push(`${route} ${m}（export されていない）`)
    }
  }

  return { missing, stale }
}
