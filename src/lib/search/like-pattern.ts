// WHY: keyword に含まれる % / _ はILIKEのワイルドカード文字なのでバックスラッシュで
// エスケープする。一方 , ( ) はPostgRESTの or() 式の区切り・グループ文字として予約されており、
// バックスラッシュエスケープでは効かない（postgrest-jsはこれらをダブルクォートで値全体を
// 囲むことで安全に渡す方式を採用している）。値全体をダブルクォートで囲み、クォート自体と
// バックスラッシュはエスケープする。
// NOTE: src/lib/compatibilities/repository.ts に存在した実証済み実装をそのまま抽出したもの
// （SPEC「人間の決定事項2」: buildIlikeValueの共有化）。products/distributor-products/repository.ts
// からも利用する。
export function buildIlikeValue(keyword: string): string {
  const wildcardEscaped = keyword
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, (c) => `\\${c}`)
  const quoteEscaped = wildcardEscaped.replace(/"/g, '\\"')
  return `"%${quoteEscaped}%"`
}

// WHY(issue #803 統合時に実DBで発見): buildIlikeValue の `"..."` 囲みは `.or()` の
//      文字列フィルタ式（comma/paren をリテラルとして残すための引用符）専用の形。
//      `.ilike(column, value)` のように単一カラムへ**直接**渡す場合、PostgREST は
//      引用符をリテラルなパターン文字として扱ってしまい、DB の値には引用符が
//      含まれていないため一致しなくなる（実測: buildIlikeValue の戻り値を
//      `.ilike()` に渡すと常に 0 件）。単一カラム直渡し専用に、引用符で囲まない版を分ける。
export function buildIlikeValueUnquoted(keyword: string): string {
  const wildcardEscaped = keyword
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, (c) => `\\${c}`)
  return `%${wildcardEscaped}%`
}
