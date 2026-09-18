// scripts/lib/fixture-guard.mjs
//
// WHY(C-030「後片付けの範囲が必要より広い」の機械化、2026-09-09):
//      2026-09-09、院内価格の spec の後片付けが**施設 A の価格を全部**消し、
//      連鎖で価格履歴まで消えて、並列で走る別の spec の土台を奪った。
//      自分の spec は緑のまま、**他人の spec が別の日に落ちる**という現れ方をする。
//
//      静的に「広い削除」を禁じる案（`.delete()` は主キーで絞れ、等）は書き方の問題になり、
//      安全な広い削除（自分が作った施設ごと消す）まで巻き込む。
//      **実害そのもの**——「テストが始まる前からあった行が消えた」——を測るほうが素直で、
//      書き方に依存しない。
//
// 仕組み:
//   1. 全 spec が走り出す**前**（フィクスチャの用意が終わった直後）に、
//      消えては困る表の鍵を全部控える
//   2. 全 spec が終わった**後**に、控えた鍵がまだあるかを見る
//   3. 1 つでも消えていれば、**誰かの後片付けが自分の作った行以外を消した**
//
//   走行中に作られた行は控えに入らないので、**自分が作ったものは自由に消せる**。
//
// 限界:
//   - 消えた「後で作り直された」場合は気づけない（鍵が同じなら生きていると見える）
//   - どの spec が消したかは分からない（消えたことしか分からない）
//   - 表は下の一覧で決め打ち。新しい表は `checkTableCoverage` が「決めていない」で落とす

/** 消えては困る表と、その鍵の列。E2E が触りうる業務データとマスタ */
export const PROTECTED_TABLES = {
  case_orders: ['id'],
  consumable_orders: ['id'],
  loan_orders: ['id'],
  loan_returns: ['id'],
  case_order_items: ['id'],
  consumable_order_items: ['id'],
  loan_order_items: ['id'],
  loan_return_items: ['id'],
  consumables: ['id'],
  hospital_prices: ['id'],
  // WHY(価格履歴を必ず入れる): 2026-09-09 の実害はここ。院内価格を消すと **ON DELETE CASCADE で
  //      履歴まで消える**。消した本人は履歴を触ったつもりがない
  price_histories: ['id'],
  products: ['id'],
  categories: ['id'],
  distributor_products: ['id'],
  product_compatibilities: ['id'],
  facilities: ['id'],
  // 複合主キー（id 列を持たない）
  user_facilities: ['user_id', 'facility_id'],
}

/** 控えない表と、その理由（**理由なしで外さない**） */
export const NOT_PROTECTED = {
  audit_log: '追記専用。削除はトリガーが拒むので、そもそも消えない',
  access_denials: '追記専用の拒否記録。削除はトリガーが拒むので消えようがない',
  privileged_operations: '追記専用の特権操作の記録。削除はトリガーが拒むので消えようがない',
  schema_drift_log: '監視の裏方。クライアントロールから触れず、E2E は 1 行も作らない',
  schema_baseline_snapshots: '同じく監視の裏方。migration だけが書く',
  rate_limit_counters: '回数のカウンタ。消えても業務データではなく、実行のたびに作り直される',
}

/** 行から鍵の文字列を作る。複合主キーは列の順に連結する */
export function keyOf(table, row) {
  const columns = PROTECTED_TABLES[table]
  if (!columns) throw new Error(`[fixture-guard] ${table} は控える表に入っていない`)
  return columns.map((c) => String(row?.[c] ?? '')).join('|')
}

/**
 * 控えた鍵のうち、いま無いものを返す。
 *
 * @param {Record<string, string[]>} snapshot 表ごとの鍵の一覧（控えたとき）
 * @param {Record<string, string[]>} present  表ごとの鍵の一覧（いま）
 * @returns {string[]} `表: 鍵` の形で、消えたものだけ
 */
export function findVanished(snapshot, present) {
  const gone = []
  for (const table of Object.keys(snapshot).sort()) {
    const now = new Set(present[table] ?? [])
    for (const key of snapshot[table]) {
      if (!now.has(key)) gone.push(`${table}: ${key}`)
    }
  }
  return gone
}

/**
 * 控えたあとに増えて、**終わっても残っている**行を返す（後片付けの漏れ）。
 *
 * WHY(消しすぎの裏返し、2026-09-10): C-030 は「消しすぎ」を測るが、統合テストで実際に
 *      積み上がっていたのは**消し残し**のほうだった（緑の全件実行 1 回につき 41 行を実測）。
 *      原因は 2 つとも「黙って失敗していた」こと——
 *      後片付けの `delete()` の戻り値を誰も見ておらず、`price_histories` からの FK と
 *      GRANT 不足で毎回 23503 / 42501 になっていた。
 *      残った行は E-022 / E-023（PostgREST の 1,000 行上限で全件を取る形のテストが
 *      古い順に切り落とされる）へ育つので、**件数そのものを測って 0 で止める**。
 *
 * 控えに無い表（あとから足した表）は全行が「増えた」扱いになる。**黙って見逃すより鳴らす**。
 *
 * @param {Record<string, string[]>} snapshot 表ごとの鍵の一覧（走り出す前）
 * @param {Record<string, string[]>} present  表ごとの鍵の一覧（終わったあと）
 * @returns {string[]} `表: 鍵` の形で、増えて残っているものだけ
 */
export function findLeaked(snapshot, present) {
  const leaked = []
  for (const table of Object.keys(present).sort()) {
    const before = new Set(snapshot[table] ?? [])
    for (const key of present[table]) {
      if (!before.has(key)) leaked.push(`${table}: ${key}`)
    }
  }
  return leaked
}

/**
 * テーブル台帳（TB-xxx）の実装済みの表が、控えるか外すかのどちらかに必ず入っていることを見る。
 *
 * WHY: 表を足した人に「E2E の後片付けで消えて困るか」を 1 回考えさせる。
 *      決めないと落ちるので、静かに片手落ちにならない。
 */
export function checkTableCoverage(tablesInRulebook) {
  const decided = new Set([...Object.keys(PROTECTED_TABLES), ...Object.keys(NOT_PROTECTED)])
  const undecided = tablesInRulebook.filter((t) => !decided.has(t))
  const stale = [...decided].filter((t) => !tablesInRulebook.includes(t))
  return { undecided, stale, noReason: reasonsTooShort(NOT_PROTECTED) }
}

/** 外す理由の下限。「あとで」「不要」で済ませられると、外した判断が残らない */
export const MIN_REASON_LENGTH = 20

/**
 * 外す理由が短すぎる表を返す。
 *
 * WHY(判定だけを取り出した): 下限そのものを外から測れないと、
 *      **下限を緩めても誰も気づかない**（2026-09-09 に CM-006 で実測: 20 → 1 にしても緑のままだった）。
 *      境界（19 文字は落ちる / 20 文字は通る）を固定するために、台帳を引数で渡せる形にする。
 */
export function reasonsTooShort(notProtected) {
  return Object.entries(notProtected)
    .filter(([, reason]) => String(reason ?? '').trim().length < MIN_REASON_LENGTH)
    .map(([t]) => t)
}
