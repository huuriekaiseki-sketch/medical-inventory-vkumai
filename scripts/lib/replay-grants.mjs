#!/usr/bin/env node
// migration を順に再生して、いま誰が何をできるか（GRANT の現存集合）を出す。
//
// WHY(issue #757 の 35): 設定ドリフト検知の「期待値」側。実 DB の権限と突き合わせるには、
//      まず**migration から導いた期待値**が要る。GRANT を数えるだけでは足りない——
//      このリポジトリは GRANT 61 文に対し **REVOKE が 72 文**あり、順に再生しないと現存集合が出ない。
//
//      `replay-rls-policies.mjs` と同じ型。あちらの教訓「数え方を 1 つ試して駄目だったことを
//      『数えられない』と書かない」もそのまま効く。
//
// 数え方:
//   - 鍵は (種別, 対象, ロール)。値は権限の集合
//   - `GRANT <権限> ON [TABLE|FUNCTION|SCHEMA] <対象> TO <ロール>` で足す
//   - `REVOKE <権限> ON ... FROM <ロール>` で引く
//   - **ALL は種別ごとの標準集合へ展開する**（表は 7 権限、関数は EXECUTE、スキーマは USAGE/CREATE）。
//     展開しないと「REVOKE ALL のあと GRANT SELECT」で SELECT が消えない
//   - 文の区切りは `;`。ただし **$$ で囲まれた関数本体の中の `;` は区切りにしない**
//   - 読めなかった GRANT/REVOKE は**黙って飛ばさず名指しする**。飛ばすと「差分なし」という嘘が出る（C-044）
//
// 限界:
//   - `WITH GRANT OPTION` は権限の有無だけ見る（付与権限の連鎖は追わない）
//   - 列単位の GRANT（`GRANT SELECT (col) ON ...`）は実例が無い。見つけたら読めない行として報告する
//   - **署名の無い関数指定**（`ON FUNCTION f TO r`）は署名 `*` として持つ。実 DB と突き合わせるときは
//     同名のどの署名にも当たるものとして扱う（曖昧さは `ambiguous` に出す）
//   - ALTER DEFAULT PRIVILEGES は追わない。見つけたら報告する
//   - 権限の**中身が正しいか**は見ない（それは RLS 変異計測 H-06 と直接攻撃の実測の担当）
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

const SEP = String.fromCharCode(0)

/** PostgreSQL の ALL が展開される標準集合（種別ごと） */
export const ALL_PRIVILEGES = {
  // WHY(MAINTAIN を含める、2026-09-18 実測): PostgreSQL 17 で追加された権限。
  //      抜かすと `REVOKE ALL ... FROM anon` のあとに MAINTAIN だけ残り、
  //      実 DB に無い権限を「期待値」として持ってしまう（実測で 25 件の嘘の差分になった）
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  function: ['EXECUTE'],
  schema: ['USAGE', 'CREATE'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
}

const RE_STMT = /^\s*(GRANT|REVOKE)\b/i
const RE_COLUMN_GRANT = /\b(?:SELECT|INSERT|UPDATE|REFERENCES)\s*\(/i
const RE_DEFAULT_PRIV = /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i
const RE_CREATE_REL = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i
const RE_DROP_REL = /^\s*DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?([\w."]+)/i
const RE_CREATE_FUNC = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(/i
const RE_DROP_FUNC = /^\s*DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s*(?:\(([^)]*)\))?/i
const RE_DO_BLOCK = /^\s*DO\s*\$/i
const RE_PRONAME_IN = /\bproname\s+IN\s*\(([\s\S]*?)\)/i

/** 引数リストから型だけを取り出す。`p_facility_id UUID DEFAULT NULL` → `uuid` */
export function parseArgTypes(argString) {
  const args = []
  let depth = 0
  let buf = ''
  for (const ch of argString) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      args.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) args.push(buf)
  return args
    .map((a) => {
      let s = a.replace(/\s+/g, ' ').trim()
      s = s.replace(/\s+DEFAULT\s+.*$/i, '').replace(/\s*=\s*.*$/, '')
      s = s.replace(/^(?:IN|OUT|INOUT|VARIADIC)\s+/i, '')
      const tokens = s.split(' ')
      // `名前 型` の形なら先頭（名前）を落とす。型だけの指定ならそのまま
      const typePart = tokens.length >= 2 ? tokens.slice(1).join(' ') : s
      return normalizeArgType(typePart)
    })
    .filter(Boolean)
}

/** `CREATE FUNCTION name(...)` の括弧の中を、対応が取れるところまで読む */
function readBalanced(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  return null
}

// WHY(プラットフォーム既定を再生に含める、2026-09-18 実測): Supabase の public スキーマには
//      「postgres が作った表には anon / authenticated / service_role へ Dxtm を与える」という
//      既定権限が設定されている（pg_default_acl で確認）。migration には 1 文も現れないので、
//      GRANT/REVOKE だけ再生すると**実在する権限を「余分」と誤検知する**
//      （例: drift_alert_view の authenticated は migration に無いのに実 DB では持っている）。
//      既定は**表が作られた時点**で付くので、CREATE を見たらそこで置く。
//      そうしないと「REVOKE ALL したあとに作られた表」の扱いを間違える。
export const PLATFORM_DEFAULT_TABLE_PRIVILEGES = ['MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE']
export const PLATFORM_DEFAULT_ROLES = ['anon', 'authenticated', 'service_role']

/**
 * GRANT / REVOKE 文を 1 つ読む。
 * @returns {{kind:'GRANT'|'REVOKE', privileges:string[], objectType:string, object:string, roles:string[]}|null}
 */
export function parseGrantStatement(stmt) {
  const flat = stmt.replace(/\s+/g, ' ').trim()
  const m = /^(GRANT|REVOKE)\s+(?:GRANT\s+OPTION\s+FOR\s+)?(.+?)\s+ON\s+(.+?)\s+(?:TO|FROM)\s+(.+?)(?:\s+WITH\s+GRANT\s+OPTION)?(?:\s+(?:CASCADE|RESTRICT))?$/i.exec(
    flat,
  )
  if (!m) return null
  const [, kindRaw, privRaw, objRaw, roleRaw] = m

  // 列単位の GRANT は対象外（実例が無い。出たら読めない行として扱う）
  if (RE_COLUMN_GRANT.test(privRaw)) return null

  let objectType = 'table'
  let object = objRaw.trim()
  const typed = /^(TABLE|FUNCTION|PROCEDURE|ROUTINE|SCHEMA|SEQUENCE|ALL\s+TABLES\s+IN\s+SCHEMA)\s+(.+)$/i.exec(object)
  if (typed) {
    const t = typed[1].toUpperCase()
    if (t.startsWith('ALL TABLES')) return null // 一括指定は展開しない（実例が無い）
    objectType = t === 'PROCEDURE' || t === 'ROUTINE' ? 'function' : t.toLowerCase()
    object = typed[2].trim()
  }

  const privileges = privRaw
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean)
  const roles = roleRaw
    .split(',')
    .map((r) => r.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((r) => (r.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : r.toLowerCase()))

  if (privileges.length === 0 || roles.length === 0) return null
  return { kind: kindRaw.toUpperCase(), privileges, objectType, object, roles }
}

// WHY(型の別名を正式名へ寄せる、2026-09-18 実測): migration は TIMESTAMPTZ / UUID と書くが、
//      PostgreSQL の format_type は `timestamp with time zone` / `uuid` を返す。
//      揃えないと関数の突き合わせが全件外れる（41 対 33 で全滅した）。
//      ここに無い型が出たら**そのまま小文字にして通す**（別名でなければ一致するため）。
const TYPE_ALIASES = new Map([
  ['timestamptz', 'timestamp with time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['timetz', 'time with time zone'],
  ['int', 'integer'],
  ['int4', 'integer'],
  ['int2', 'smallint'],
  ['int8', 'bigint'],
  ['bool', 'boolean'],
  ['float8', 'double precision'],
  ['float4', 'real'],
  ['varchar', 'character varying'],
  ['char', 'character'],
  ['decimal', 'numeric'],
])

export function normalizeArgType(raw) {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  const arraySuffix = t.endsWith('[]') ? '[]' : ''
  const base = arraySuffix ? t.slice(0, -2).trim() : t
  return (TYPE_ALIASES.get(base) ?? base) + arraySuffix
}

/** 対象名を正規化する。public. を外し、関数は 名前(型,型) の形へ揃える */
export function normalizeObject(objectType, raw) {
  let s = raw.trim().replace(/^"|"$/g, '')
  if (objectType === 'function') {
    const m = /^([\w."]+)\s*(?:\((.*)\))?$/s.exec(s)
    if (!m) return s.toLowerCase()
    const name = m[1].replace(/^public\./i, '').replace(/"/g, '').toLowerCase()
    if (m[2] === undefined) return `${name}(*)`
    const args = m[2]
      .split(',')
      .map((a) => normalizeArgType(a))
      .filter(Boolean)
      .join(',')
    return `${name}(${args})`
  }
  return s.replace(/^public\./i, '').toLowerCase()
}

/** $$ や $tag$ の中を避けて `;` で文に割る */
export function splitStatements(sql) {
  const noLineComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
  const out = []
  let buf = ''
  let i = 0
  let tag = null
  while (i < noLineComments.length) {
    if (tag) {
      if (noLineComments.startsWith(tag, i)) {
        buf += tag
        i += tag.length
        tag = null
        continue
      }
      buf += noLineComments[i]
      i += 1
      continue
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(noLineComments.slice(i))
    if (dollar) {
      tag = dollar[0]
      buf += tag
      i += tag.length
      continue
    }
    if (noLineComments[i] === ';') {
      out.push(buf)
      buf = ''
      i += 1
      continue
    }
    buf += noLineComments[i]
    i += 1
  }
  if (buf.trim()) out.push(buf)
  return out
}

/**
 * migration ディレクトリを再生する。
 * @returns {{live: Array<{objectType:string,object:string,role:string,privileges:string[]}>,
 *            grants:number, revokes:number, unparsed:string[], risky:string[],
 *            ambiguous:string[], files:number}}
 */
export function replayGrants(migrationsDir, options = {}) {
  /** @type {Map<string, Set<string>>} */
  const live = new Map()
  /** 関数名 → その時点で生きている署名の集合 */
  const liveFunctions = new Map()
  const unparsed = []
  const risky = []
  const ambiguousSet = new Set()
  let grants = 0
  let revokes = 0

  /** `name(*)` を、その時点で生きている全署名へ展開する */
  const expandFunctionObject = (obj) => {
    if (!obj.endsWith('(*)')) return [obj]
    const name = obj.slice(0, -3)
    const sigs = [...(liveFunctions.get(name) ?? [])]
    if (sigs.length === 0) {
      ambiguousSet.add(`${obj}（この時点で署名が分からず、そのまま持っています）`)
      return [obj]
    }
    return sigs
  }

  const applyGrant = ({ kind, privileges, objectType, object, roles }) => {
    const objects =
      objectType === 'function' ? expandFunctionObject(normalizeObject(objectType, object)) : [normalizeObject(objectType, object)]
    const expanded = privileges.includes('ALL')
      ? ALL_PRIVILEGES[objectType] ?? ALL_PRIVILEGES.table
      : privileges
    for (const obj of objects) {
      for (const role of roles) {
        const key = `${objectType}${SEP}${obj}${SEP}${role}`
        const set = live.get(key) ?? new Set()
        if (kind === 'GRANT') {
          grants += 1
          for (const p of expanded) set.add(p)
          live.set(key, set)
        } else {
          revokes += 1
          for (const p of expanded) set.delete(p)
          if (set.size === 0) live.delete(key)
          else live.set(key, set)
        }
      }
    }
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const text = readFileSync(path.join(migrationsDir, file), 'utf8')
    const statements = splitStatements(text)
    // WHY(コメントを除いた文で見る、2026-09-18 実測): 本文全体を正規表現に掛けると
    //      「ALTER DEFAULT PRIVILEGES を使っていない」と**説明しているコメント**まで拾い、
    //      実際には無い注意が 5 件出た。嘘の注意は本物の注意を埋もれさせる。
    if (statements.some((s) => RE_DEFAULT_PRIV.test(s))) {
      risky.push(`${file}: ALTER DEFAULT PRIVILEGES は追っていません`)
    }
    for (const stmt of statements) {
      // 関数の署名を追う。`ON FUNCTION name`（署名なし）や動的 DDL を、
      // **その時点で生きている全署名**へ展開するために要る
      const cf = RE_CREATE_FUNC.exec(stmt)
      if (cf) {
        const open = stmt.indexOf('(', cf.index)
        const inner = readBalanced(stmt, open)
        if (inner === null) {
          unparsed.push(`${file}: CREATE FUNCTION の引数が読めません: ${cf[1]}`)
        } else {
          const name = cf[1].replace(/"/g, '').replace(/^public\./i, '').toLowerCase()
          const sig = `${name}(${parseArgTypes(inner).join(',')})`
          if (!liveFunctions.has(name)) liveFunctions.set(name, new Set())
          liveFunctions.get(name).add(sig)
        }
      }
      const df = RE_DROP_FUNC.exec(stmt)
      if (df) {
        const name = df[1].replace(/"/g, '').replace(/^public\./i, '').toLowerCase()
        const sigs = df[2] === undefined ? [...(liveFunctions.get(name) ?? [])] : [`${name}(${parseArgTypes(df[2]).join(',')})`]
        for (const sig of sigs) {
          liveFunctions.get(name)?.delete(sig)
          for (const key of [...live.keys()]) {
            if (key.startsWith(`function${SEP}${sig}${SEP}`)) live.delete(key)
          }
        }
        continue
      }

      // WHY(動的 DDL を展開する、2026-09-18 実測): 20260911000001 は DO ブロックの中で
      //      `EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig)` を
      //      関数名の一覧ぶん回している。展開しないと**黙って飛ばす**ことになり、
      //      「実環境にあるが期待に無い」という嘘の差分が 4 件出た（C-044 の型。
      //      replay-rls-policies.mjs が同じ問題を先に解いている）
      if (RE_DO_BLOCK.test(stmt) && RE_STMT.test(stmt.replace(/^[\s\S]*?format\(\s*'/, ''))) {
        const names = RE_PRONAME_IN.exec(stmt)
        if (!names) {
          if (/format\(\s*'\s*(GRANT|REVOKE)/i.test(stmt)) {
            unparsed.push(`${file}: 動的 GRANT/REVOKE の対象一覧が読めません`)
          }
          continue
        }
        const targets = names[1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
        for (const m of stmt.matchAll(/format\(\s*'((?:GRANT|REVOKE)[^']*)'/gi)) {
          for (const target of targets) {
            const sql = m[1].replace(/%s/g, `${target}(*)`).replace(/%I/g, target)
            const parsed = parseGrantStatement(`${sql.replace(/\bON\s+FUNCTION\b/i, 'ON FUNCTION')}`)
            if (!parsed) {
              unparsed.push(`${file}: 動的 GRANT/REVOKE が読めません: ${sql.slice(0, 100)}`)
              continue
            }
            applyGrant(parsed, { dynamic: true })
          }
        }
        continue
      }

      // 表・ビューが作られたら、その時点でプラットフォーム既定を置く
      const created = RE_CREATE_REL.exec(stmt)
      if (created && options.platformDefaults !== false) {
        const obj = normalizeObject('table', created[1])
        for (const role of PLATFORM_DEFAULT_ROLES) {
          const key = `table${SEP}${obj}${SEP}${role}`
          if (!live.has(key)) live.set(key, new Set(PLATFORM_DEFAULT_TABLE_PRIVILEGES))
        }
        continue
      }
      const dropped = RE_DROP_REL.exec(stmt)
      if (dropped) {
        const obj = normalizeObject('table', dropped[1])
        for (const key of [...live.keys()]) {
          if (key.startsWith(`table${SEP}${obj}${SEP}`)) live.delete(key)
        }
        continue
      }
      if (!RE_STMT.test(stmt)) continue
      const parsed = parseGrantStatement(stmt)
      if (!parsed) {
        unparsed.push(`${file}: ${stmt.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
        continue
      }
      applyGrant(parsed)
    }
  }

  const rows = [...live.entries()]
    .map(([key, set]) => {
      const [objectType, object, role] = key.split(SEP)
      return { objectType, object, role, privileges: [...set].sort() }
    })
    .sort((a, b) =>
      `${a.objectType}/${a.object}/${a.role}`.localeCompare(`${b.objectType}/${b.object}/${b.role}`),
    )

  return {
    live: rows,
    grants,
    revokes,
    unparsed,
    risky,
    ambiguous: [...ambiguousSet].sort(),
    files: files.length,
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const idx = process.argv.indexOf('--migrations')
  const dir = idx >= 0 ? process.argv[idx + 1] : 'supabase/migrations'
  const result = replayGrants(dir)
  if (process.argv.includes('--json')) {
    writeLine(JSON.stringify(result, null, 2))
  } else {
    writeLine(`files=${result.files} grants=${result.grants} revokes=${result.revokes} live=${result.live.length}`)
    for (const u of result.unparsed) writeLine(`  読めない: ${u}`)
    for (const r of result.risky) writeLine(`  注意: ${r}`)
    for (const a of result.ambiguous) writeLine(`  曖昧: ${a}`)
  }
  // 読めない行があれば落とす（黙って通すと「差分なし」が嘘になる）
  process.exit(result.unparsed.length === 0 ? 0 : 1)
}
