// scripts/lib/audit-report.mjs
//
// WHY(issue #876): `npm audit --json` の出力を読み、issue の題名・ラベル・本文を組み立てる。
//      呼び出し元は scripts/lib/audit-issue.sh（gh を叩く側）。判定をここに置き、YAML に書かない。
//
//      **脆弱性が見つかった**と**audit 自体が失敗した**は、どちらも npm の終了コードが 1 で区別が付かない。
//      後者を `[audit] npm` として起票すると、直す先が依存だと誤解させる（flaky-issue.sh の exit 4 と同じ理由）。
//      逆に黙ると「脆弱性 0 件」と読める（C-025: 合格・検査不能を 1 つの真偽値に潰す）。
//      なので次の 4 つに分ける:
//        vulnerable   high 以上がある                       → `[audit] npm`（security）
//        audit-error  出力が `{"error": ...}`               → `[env] npm audit`（bug）
//        unreadable   出力が空・JSON でない                  → `[env] npm audit`（bug）
//        mismatch     終了コードは 0 以外なのに high 以上が無い → `[env] npm audit`（bug）
//
// 使い方: node scripts/lib/audit-report.mjs <audit.json> <status>
// 出力: 1 行目 = 題名、2 行目 = ラベル、3 行目以降 = 本文（Markdown）
//
// 限界:
//   - 閾値は CI と同じ high 固定。moderate 以下は載せない
//   - 「直った」ことは知らせない（緑の日に issue を閉じない）。閉じるのは人

import fs, { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BLOCKING = new Set(['high', 'critical'])

export function classify(raw, status) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object') {
    return { kind: 'unreadable' }
  }
  if (data.error) {
    return { kind: 'audit-error', error: data.error }
  }
  const vulns = Object.values(data.vulnerabilities ?? {}).filter((v) => BLOCKING.has(v?.severity))
  if (vulns.length > 0) {
    return { kind: 'vulnerable', vulns, metadata: data.metadata?.vulnerabilities ?? {} }
  }
  return { kind: 'mismatch', status }
}

function advisories(v) {
  // via は advisory のオブジェクトか、別パッケージ名（推移的な依存）の文字列が混ざる
  const items = (v.via ?? []).filter((x) => x && typeof x === 'object')
  if (items.length === 0) {
    const names = (v.via ?? []).filter((x) => typeof x === 'string')
    return names.length > 0 ? `（${names.join(', ')} 経由）` : '—'
  }
  return items.map((x) => `[${x.title ?? x.url}](${x.url})`).join('<br>')
}

function fixVersion(v) {
  const f = v.fixAvailable
  if (f && typeof f === 'object') return `${f.name}@${f.version}${f.isSemVerMajor ? '（major）' : ''}`
  if (f === true) return 'あり（`npm audit fix`）'
  return 'なし'
}

export function render(result) {
  if (result.kind === 'vulnerable') {
    const rows = result.vulns
      .sort((a, b) => (a.severity === b.severity ? a.name.localeCompare(b.name) : a.severity === 'critical' ? -1 : 1))
      .map((v) => `| \`${v.name}\` | ${v.severity} | ${v.range ?? '—'} | ${fixVersion(v)} | ${advisories(v)} |`)
    const m = result.metadata
    return {
      title: '[audit] npm',
      label: 'security',
      body: [
        `## 本番依存に high 以上の公開済み脆弱性があります（${result.vulns.length} 件）`,
        '',
        '| パッケージ | 重大度 | 当たっている範囲 | 修正版 | advisory |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
        `全体の件数（閾値未満を含む）: critical ${m.critical ?? 0} / high ${m.high ?? 0} / moderate ${m.moderate ?? 0} / low ${m.low ?? 0}`,
        '',
        '依存を上げる PR は `docs/agents/common.md`「依存関係の変更ルール」に従う（用途・代替案・`npm ci`・audit の結果を PR に書く）。',
      ].join('\n'),
    }
  }
  if (result.kind === 'audit-error') {
    const e = result.error
    return {
      title: '[env] npm audit',
      label: 'bug',
      body: [
        `## npm audit 自体が失敗しました（${e.code ?? 'コード不明'}）`,
        '',
        '**脆弱性の有無は分かっていない。** 合格とも違反とも読まないこと。',
        '',
        `- summary: ${e.summary ?? '—'}`,
        `- detail: ${(e.detail ?? '—').split('\n').join(' / ')}`,
        '',
        '探す先はレジストリ・ネットワーク・lockfile。依存そのものではない。',
      ].join('\n'),
    }
  }
  if (result.kind === 'unreadable') {
    return {
      title: '[env] npm audit',
      label: 'bug',
      body: [
        '## npm audit の結果を読めなかった（出力が空、または JSON でない）',
        '',
        '**脆弱性の有無は分かっていない。** Actions のログと artifact の `audit.json` を見る。',
      ].join('\n'),
    }
  }
  return {
    title: '[env] npm audit',
    label: 'bug',
    body: [
      `## 終了コードと中身の食い違い（exit ${result.status} なのに high 以上が 0 件）`,
      '',
      '閾値の指定（`--audit-level`）と集計がずれている可能性がある。Actions のログと artifact の `audit.json` を見る。',
    ].join('\n'),
  }
}

// 直接起動の判定は実体パスで比べる（issue #806。symlink を含むパスで無出力・exit 0 にならないように）
function isRunAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
if (isRunAsCli()) {
  const [file, status] = process.argv.slice(2)
  const raw = fs.readFileSync(file, 'utf8')
  const { title, label, body } = render(classify(raw, status))
  process.stdout.write(`${title}\n${label}\n${body}\n`)
}
