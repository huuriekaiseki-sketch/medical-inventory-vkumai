// supabase/migrations/__tests__/allow_retiring_consumables.test.ts
// WHY(2026-09-09): 消耗品に使用停止（`retired`）を足した migration の形を固定する。
//      特に **共有している `enforce_status_forward_only` を書き直している**ので、
//      E-064（古い版を元に書き直して守りを落とす）が起きていないことをここで見る。
//      振る舞い（active → retired が通り、retired → active が 23514）は
//      `supabase/__tests__/integration/business-invariants.integration.test.ts` が実 DB で測る。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE = join(process.cwd(), 'supabase/migrations/20260909010000_allow_retiring_consumables.sql')
const n = readFileSync(FILE, 'utf8').toLowerCase().replace(/\s+/g, ' ')

describe('20260909010000_allow_retiring_consumables', () => {
  it('migration ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('status 列は既定 active で、語彙は active / retired だけ', () => {
    expect(n).toContain("add column if not exists status text not null default 'active' check (status in ('active', 'retired'))")
  })

  // WHY: 「終端へは進める」を消すと、消耗品は使用停止にできなくなる（実測で一度そうなった）。
  //      「終端からは戻れない」を消すと、止めたものが復活する
  it('終端の語彙に retired を足し、終端からは戻れないままにしている', () => {
    expect(n).toContain("if old.status in ('cancelled', 'retired') then")
    expect(n).toContain("elsif new.status in ('cancelled', 'retired') then")
    expect(n).toContain("elsif old.status <> 'draft' then")
  })

  // WHY(E-064): CREATE OR REPLACE は本文をまるごと差し替える。
  //      20260908060000 の版が持っていた守り（search_path を空にする・check_violation を投げる）が
  //      落ちていないことを見る
  it('関数の守り（search_path を空にする・check_violation）を落としていない', () => {
    expect(n).toContain('create or replace function enforce_status_forward_only() returns trigger')
    expect(n).toContain("set search_path = ''")
    expect(n).toContain("using errcode = 'check_violation'")
  })

  // WHY(C-010): 不変条件カタログ I-020 は「BEFORE UPDATE OF status」と書いてある。
  //      宣言と実態を揃える（20260909000000 の明細のトリガーもここで同じ形に直している）
  it.each(['consumables', 'loan_return_items'])(
    '%s のトリガーは BEFORE UPDATE OF status の形',
    (table) => {
      expect(n).toContain(`create trigger ${table}_status_forward_only before update of status on ${table} for each row execute function enforce_status_forward_only();`)
    },
  )

  it('テーブルの新設・削除を伴わない（baseline snapshot の更新は不要）', () => {
    expect(n).not.toMatch(/create table|drop table/)
  })
})
