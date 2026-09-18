// aidd-phase2.js の Coverage Check フェーズ（issue #508 / R03）の判定ロジック。
//
// 何を直したか（issue R03）: hasChanges を「baseCommit 以降に 1 件でもファイルが変わったか」で
// 決めていたため、**SPEC.md や .aidd/run-manifest.json しか変わっていない実行でも
// hasChanges: true** になった。仕様書を書いたことが「実装した」ことに化け、
// 実装漏れを埋めるための汎用 implementer が起動しないまま統合ゲートへ進んでいた。
//
// 注意（構造的な制約）: manifest-check.js と同じく、実際に動くのは Workflow DSL 内の
// 自然言語プロンプト指示であり、この関数は実行パスに配線されていない。
// 「プロンプトが表現しようとしている判定を、文書化かつテスト可能な形で保持する」ためのもの。
// プロンプト側との対応は __tests__/coverage-check.test.js が文字列で見張る。

// 実装物として数えない場所。**ここを広げると「実装したことにならない変更」が増える**ので、
// 迷ったら実装物側（＝数える側）へ倒す。
// - 仕様書そのもの: 書いただけで実装済みにしない（R03 の本体）
// - .aidd/: この実行自身の記録
// - logs/: 観測の記録
const NON_IMPLEMENTATION_PREFIXES = ['.aidd/', 'logs/']

function normalize(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

// changedFiles: 変更ファイルの相対パス一覧
// specPath: 仕様書のパス（絶対でも相対でも、末尾一致で判定する）
// 戻り値: { implementationFiles, excluded, hasChanges }
export function classifyCoverage(changedFiles, specPath) {
  const spec = normalize(specPath ?? 'SPEC.md')
  const specName = spec.split('/').pop()
  const implementationFiles = []
  const excluded = []
  for (const raw of changedFiles ?? []) {
    const f = normalize(raw)
    if (f === '') continue
    const isSpec = f === spec || f.endsWith(`/${specName}`) || f === specName
    const isRecord = NON_IMPLEMENTATION_PREFIXES.some(prefix => f.startsWith(prefix))
    if (isSpec || isRecord) excluded.push(f)
    else implementationFiles.push(f)
  }
  return { implementationFiles, excluded, hasChanges: implementationFiles.length > 0 }
}

// items: [{ item, files, verification }] — SPEC Part 2 の実装項目ごとの対応表
// 戻り値: 実装物が 1 件も対応していない項目の名前
//
// WHY: 「変更が 1 件でもあった」は実装項目の充足を意味しない。5 項目のうち 1 項目だけ
//      直しても hasChanges は true になる。項目ごとに対応を要求して、
//      **どの項目が空のままか**を名指しできるようにする。
export function unmatchedItems(items) {
  return (items ?? [])
    .filter(entry => (entry?.files ?? []).length === 0)
    .map(entry => entry?.item ?? '(名前なし)')
}
