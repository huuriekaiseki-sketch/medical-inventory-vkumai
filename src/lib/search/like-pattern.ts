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
