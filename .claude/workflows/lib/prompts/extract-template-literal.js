// ソーステキスト中のテンプレートリテラル（バッククォート区切り）を、${...}のネスト
// （波括弧を含む式も可）を考慮しつつ全て走査し、中身にcontentMarkerを含む最初の1つを
// 生テキスト（変数展開を評価しない、${specPath}等がそのまま残った状態）で返す。
//
// 用途: Workflow DSL（require不可）内にインライン複製されたプロンプト文字列と、lib側の
// 正本を「評価せず生テキストとして」比較するため（workflow-prompt-sync.test.js参照）。
// 変数展開後の値で比較すると、比較用に別途変数を用意する必要があり実装が複雑化するうえ、
// 変数の扱いでズレが生じうる。生テキスト比較ならその心配がない（issue #391 design doc参照）。
//
// 制約: リテラル内部にバッククォート文字そのものが含まれるケース（ネストしたテンプレート
// リテラル）は非対応。現状のワークフロープロンプトはこのケースに該当しない。
export function extractTemplateLiteralContaining(sourceText, contentMarker) {
  const literals = []
  let i = 0
  while (i < sourceText.length) {
    if (sourceText[i] === '`') {
      const start = i + 1
      let j = start
      let interpolationDepth = 0
      while (j < sourceText.length) {
        const ch = sourceText[j]
        if (interpolationDepth === 0 && ch === '`') break
        if (interpolationDepth === 0 && ch === '$' && sourceText[j + 1] === '{') {
          interpolationDepth = 1
          j += 2
          continue
        }
        if (interpolationDepth > 0) {
          if (ch === '{') interpolationDepth++
          else if (ch === '}') interpolationDepth--
        }
        j++
      }
      literals.push(sourceText.slice(start, j))
      i = j + 1
      continue
    }
    i++
  }
  const found = literals.find(text => text.includes(contentMarker))
  if (found === undefined) {
    throw new Error(`extractTemplateLiteralContaining: no template literal contains marker: ${contentMarker}`)
  }
  return found
}
