// ソーステキストから、指定した名前のトップレベル宣言（`const NAME = ...;` または
// `function NAME(...) { ... }`、いずれも先頭に`export `が付いていてもよい）を
// 生テキストで抽出する。抽出結果は比較用に先頭の`export `を取り除いて正規化する
// （lib側の正本はexportし、Workflow DSL側のインライン複製はexportしないため、
// export有無だけの差分を「同期している」とみなすための正規化）。
//
// 用途: Workflow DSL（require不可）内にインライン複製された判定ロジック（関数・定数配列）と、
// lib側の正本を「評価せず生テキストとして」比較するため
// （router-risk-sync.test.js参照。プロンプト文字列版のextract-template-literal.jsと同型）。
//
// 制約: 宣言本体の最初の `{` または `[` から対応する閉じ括弧までを、同じ括弧種別のみで
// 深さカウントして抽出する。宣言本体の中に異なる種別の括弧（例: 関数本体`{}`内の配列`[]`）が
// あっても、深さカウント対象は開始時に選んだ括弧種別のみのため誤爆しない。ネストした
// テンプレートリテラル（バッククォート）を含む宣言は非対応（現状の対象宣言はいずれも該当しない）。
export function extractDeclaration(sourceText, name) {
  const declPattern = new RegExp(`(?:export\\s+)?(?:const|function)\\s+${name}\\b`)
  const match = declPattern.exec(sourceText)
  if (!match) {
    throw new Error(`extractDeclaration: declaration not found: ${name}`)
  }
  const normalizedDecl = match[0].replace(/^export\s+/, '')
  const bodyStart = sourceText.indexOf(normalizedDecl, match.index)

  let i = bodyStart
  while (i < sourceText.length && sourceText[i] !== '{' && sourceText[i] !== '[') i++
  if (i >= sourceText.length) {
    throw new Error(`extractDeclaration: no block opener ('{' or '[') found for: ${name}`)
  }

  const open = sourceText[i]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let j = i
  for (; j < sourceText.length; j++) {
    if (sourceText[j] === open) depth++
    else if (sourceText[j] === close) {
      depth--
      if (depth === 0) {
        j++
        break
      }
    }
  }

  let end = j
  if (sourceText[end] === ';') end++

  return sourceText.slice(bodyStart, end).trim()
}
