// issue #431のrecallベンチマーク用fixture。層をまたぐ型不一致を意図的に再現している。
// このEvalFixtureRecallItem型は、対応するrepository.tsのmapRow()が実際に返す
// internalNoteフィールドを宣言していない（DB列は存在するが型定義に欠落）。
export type EvalFixtureRecallItem = {
  id: string
  name: string
}
