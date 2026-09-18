#!/usr/bin/env node
// migration と `process.env.*` の走査から「こうなっているはず」を 1 つの JSON にまとめる。
//
// WHY(issue #757 の 35): 設定ドリフト検知の期待値側。突き合わせ相手は
//   `public.config_snapshot()`（20260918000000）が返す実環境の姿。
//
// **プラットフォーム既定を足さないと合わない**（2026-09-18 実測）:
//   Supabase の `public` スキーマには `postgres` が作る表に対する既定権限が設定されていて、
//   anon / authenticated / service_role へ自動で `Dxtm`（TRUNCATE・REFERENCES・TRIGGER・MAINTAIN）が付く。
//     postgres|public|r|{... anon=Dxtm/postgres, authenticated=Dxtm/postgres, service_role=Dxtm/postgres}
//   migration には現れないので、再生結果だけを期待値にすると**実在する権限を「余分」と誤検知する**
//   （例: drift_alert_view の authenticated は migration に 1 文も無いのに実 DB では持っている）。
//   なので式はこう:
//       期待値 = プラットフォーム既定 ∪（migration の GRANT/REVOKE を順に再生）
//   REVOKE は既定ぶんも消せる（`REVOKE ALL ON case_orders FROM anon` で anon は何も持たなくなる）ので、
//   既定を先に置いてから再生を適用する。
//
// 限界:
//   - 既定権限の値は**このプロジェクトの実測**（2026-09-18）。Supabase 側が変えたらここも変える。
//     変わったことは差分として出るので、黙って通ることはない
//   - MAINTAIN は PostgreSQL 17 の権限で、古い information_schema には出ない。
//     `config_snapshot()` は `aclexplode` を使うので出る。比較の対象に含める
//   - Storage policy・GitHub のブランチ保護・Vercel の環境変数は**含まない**（外部の口が別）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { PLATFORM_DEFAULT_ROLES, replayGrants } from './replay-grants.mjs'
import { replayPolicies } from './replay-rls-policies.mjs'
import { writeLine } from './stdout-sync.mjs'

/** 比較する相手のロール（postgres は所有者なので常に全権限。見ても意味がない） */
export const COMPARED_ROLES = PLATFORM_DEFAULT_ROLES

/** src/ と scripts/ が読む環境変数のうち、製品の実行時に要るものだけ */
export function scanRuntimeEnvNames(root) {
  const names = new Set()
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue
      if (/\.test\.(ts|tsx)$/.test(entry)) continue
      const text = readFileSync(full, 'utf8')
      for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1])
    }
  }
  walk(path.join(root, 'src'))
  return [...names].sort()
}

/** 実行環境が与えるもの（この製品が用意するのではない）。期待値からは外す */
export const PLATFORM_ENV_NAMES = new Set(['NODE_ENV', 'CI', 'TZ'])

export function buildExpected(root) {
  const migrationsDir = path.join(root, 'supabase/migrations')
  // プラットフォーム既定の適用は replayGrants の中（CREATE を見た時点）で行う。
  // ここで後付けすると「REVOKE ALL したあとに作られた表」の扱いを間違える
  const grants = replayGrants(migrationsDir)
  const policies = replayPolicies(migrationsDir)

  const tableGrants = grants.live
    .filter((r) => r.objectType === 'table' && COMPARED_ROLES.includes(r.role))
    .map((r) => ({ object: r.object, role: r.role, privileges: r.privileges }))

  const functionGrants = grants.live
    .filter((r) => r.objectType === 'function' && COMPARED_ROLES.includes(r.role))
    .map((r) => ({ object: r.object, role: r.role, privileges: r.privileges }))

  const envNames = scanRuntimeEnvNames(root).filter((n) => !PLATFORM_ENV_NAMES.has(n))

  return {
    _comment:
      'issue #757 の 35。migration と process.env.* の走査から導いた期待値。生成物なので手で編集しない（bash scripts/build-config-expected.sh）。',
    generatedFrom: {
      migrations: grants.files,
      grantStatements: grants.grants,
      revokeStatements: grants.revokes,
      policyCreates: policies.creates,
      policyDrops: policies.drops,
    },
    unparsed: grants.unparsed,
    ambiguousFunctions: grants.ambiguous,
    tableGrants,
    functionGrants,
    policies: policies.live
      .map(([object, name]) => ({ object, name }))
      .sort((a, b) => `${a.object}/${a.name}`.localeCompare(`${b.object}/${b.name}`)),
    envNames,
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const idx = process.argv.indexOf('--root')
  const root = idx >= 0 ? process.argv[idx + 1] : process.cwd()
  writeLine(JSON.stringify(buildExpected(root), null, 2))
}
