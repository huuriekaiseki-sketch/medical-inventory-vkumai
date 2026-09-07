import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 27 の続き（優先順位 4）。`service_role` は RLS を通らないので、
//      **認可はアプリ側のガードにしか無い**。ガードを書き忘れても DB は止めてくれない。
//      RLS 経路は文ごとに `is_facility_writer()` を評価し直すが、service_role にはそれが無い。
//
//      だから「どのファイルが service_role で書くか」と「何を根拠にしているか」を
//      docs/agents/privileged-write-rulebook.md（W-xxx）に 1 枚でまとめ、
//      ここで**宣言とコードを両方向で**突き合わせる。
//      新しく service_role を使うファイルが増えたら、まずここが「宣言が無い」で落ちる。
//
//      隙間そのもの（判定から書くまで）は消せないので、実 DB での実測は
//      supabase/__tests__/integration/permission-race.integration.test.ts が受け持つ。

const REPO_ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(REPO_ROOT, 'src')
const RULEBOOK = 'docs/agents/privileged-write-rulebook.md'

/** service_role クライアントを作る「工場」そのもの。ここは経路ではない */
const FACTORY = 'src/lib/supabase/server.ts'

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** src 配下の .ts / .tsx を集める（テストは対象外） */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (name === '__tests__') continue
      sourceFiles(abs, out)
      continue
    }
    if (!/\.tsx?$/.test(name)) continue
    if (/\.test\.tsx?$/.test(name)) continue
    out.push(path.relative(REPO_ROOT, abs))
  }
  return out
}

/** service_role クライアントを実際に作っているファイル（コメントでの言及は数えない） */
function serviceRoleFiles(): string[] {
  return sourceFiles(SRC)
    .filter((rel) => rel !== FACTORY)
    .filter((rel) => {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf-8'))
      return /createAdminSupabase\s*\(/.test(code) || /SUPABASE_SERVICE_ROLE_KEY/.test(code)
    })
    .sort()
}

interface Row {
  id: string
  route: string
  guard: string
  status: string
}

function loadRulebook(): Row[] {
  const text = readFileSync(path.join(REPO_ROOT, RULEBOOK), 'utf-8')
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!/^\|\s*W-/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    expect(cells.length, `${cells[0]}: 8 列でない（${cells.length}）`).toBe(8)
    const [id, route, , guard, , , , status] = cells
    rows.push({
      id,
      route: (route.match(/`([^`]+)`/) ?? [])[1] ?? route,
      guard: (guard.match(/`([^`]+)`/) ?? [])[1] ?? guard,
      status,
    })
  }
  return rows
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-023 権限の変更は次のリクエストから効く
describe('RLS を通らない書き込みは、必ず宣言と根拠を持つ [P-023]', () => {
  const rows = loadRulebook()
  const declared = new Set(rows.map((r) => r.route))
  const actual = serviceRoleFiles()

  it('走査そのものが壊れていない（壊れると全件素通りして「合格」に見える）', () => {
    // fail-open 防止。0 件になったら突合が意味を失う
    // 2026-09-07: W-010（所属と役割）は service_role をやめて RLS 経由にしたのでこの表から外れた。
    //      経路が減るのは良い直り方なので、下限は 3 に下げる（0 になったら突合が意味を失う）。
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(actual.length).toBeGreaterThanOrEqual(3)
  })

  it('service_role を使うファイルはすべて宣言されている（新しい経路はここで必ず止まる）', () => {
    const undeclared = actual
      .filter((f) => !declared.has(f))
      .map((f) => `${f}（${RULEBOOK} に 1 行足すこと）`)
    expect(undeclared).toEqual([])
  })

  it('宣言に、service_role を使っていないファイルが残っていない（リスト陳腐化の検知）', () => {
    const stale = [...declared]
      .filter((f) => !actual.includes(f))
      .map((f) => `${f}（もう service_role を使っていない。表から消すこと）`)
    expect(stale).toEqual([])
  })

  it('「認可の判定」に書いた関数を、そのファイルが実際に呼んでいる', () => {
    // WHY: ここが要。表に `requireAdmin` と書いてあるのに呼んでいない、が
    //      いちばん起きやすい形（新しい admin route をコピーして作ったとき）。
    const problems: string[] = []
    for (const row of rows) {
      if (row.guard === '無し') continue
      const code = stripComments(readFileSync(path.join(REPO_ROOT, row.route), 'utf-8'))
      if (!new RegExp(`\\b${row.guard}\\s*\\(`).test(code)) {
        problems.push(`${row.id}: ${row.route} が ${row.guard}() を呼んでいない`)
      }
    }
    expect(problems).toEqual([])
  })

  it('API の route は必ず認可の判定を持つ（判定なしで書けるのは記録の裏方だけ）', () => {
    // WHY: 記録（拒否・回数）は「起きた事実」なので判定を持たない。
    //      それ以外、とくに src/app/api/ の下は必ず判定が要る。
    const problems = rows
      .filter((r) => r.route.startsWith('src/app/api/') && r.guard === '無し')
      .map((r) => `${r.id}: ${r.route} が認可の判定なしで service_role を使っている`)
    expect(problems).toEqual([])
  })
})
