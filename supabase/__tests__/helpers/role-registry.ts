// WHY: 施設ロールの決めごとの正本は docs/agents/role-rulebook.md（R-xxx）1 枚。
//      ここはその表を読んで機械が使える形にするだけで、**判断は 1 文字も持たない**
//      （TS に書き写すと、また「5 か所目」ができてしまう）。
//
//      表の形（列数・ID・状態の語彙・守るテストのパス実在）は汎用エンジン
//      scripts/lib/check-catalog.mjs が見る。中身（SQL / TypeScript の許可リストとの一致）は
//      supabase/migrations/__tests__/role_registry.test.ts が見る。

import { readFileSync } from 'fs'
import path from 'path'

export const ROLE_RULEBOOK_PATH = 'docs/agents/role-rulebook.md'

export interface RoleDecl {
  id: string
  role: string
  /** 所属施設の行を読めるか */
  reads: boolean
  /** 所属施設の行を書けるか（is_facility_writer に載るか） */
  writes: boolean
  /** マスタを書けるか（is_admin に載るか） */
  admin: boolean
  /** 画面が書き込み UI を出すか（useFacilityRole の canWrite に載るか） */
  ui: boolean
  guardedBy: string[]
  status: string
}

function parseYesNo(cell: string, id: string, column: string): boolean {
  const v = cell.trim()
  if (v === 'はい') return true
  if (v === 'いいえ') return false
  throw new Error(`${ROLE_RULEBOOK_PATH}: ${id} の「${column}」が はい / いいえ でない: ${v}`)
}

/** ロール名 → 決めごと。正本は docs/agents/role-rulebook.md */
export function loadRoleRulebook(): Record<string, RoleDecl> {
  const text = readFileSync(path.join(path.resolve(__dirname, '../../..'), ROLE_RULEBOOK_PATH), 'utf-8')
  const out: Record<string, RoleDecl> = {}

  for (const line of text.split('\n')) {
    if (!/^\|\s*R-/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length !== 8) {
      throw new Error(`${ROLE_RULEBOOK_PATH}: 8 列でない行がある（${cells[0]}）`)
    }
    const [id, role, reads, writes, admin, ui, guarded, status] = cells
    if (out[role]) throw new Error(`${ROLE_RULEBOOK_PATH}: ${role} の行が 2 つある`)
    out[role] = {
      id,
      role,
      reads: parseYesNo(reads, id, '施設の行を読む'),
      writes: parseYesNo(writes, id, '施設の行を書く'),
      admin: parseYesNo(admin, id, 'マスタを書く'),
      ui: parseYesNo(ui, id, '画面の書き込み UI'),
      guardedBy: [...guarded.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      status,
    }
  }

  // fail-open 防止: 表が読めなくなったら「宣言 0 件」＝全部素通りになるので、ここで落とす
  if (Object.keys(out).length < 3) {
    throw new Error(`${ROLE_RULEBOOK_PATH} から読めた行が ${Object.keys(out).length} 件しかない`)
  }
  return out
}

export const ROLE_REGISTRY: Record<string, RoleDecl> = loadRoleRulebook()
