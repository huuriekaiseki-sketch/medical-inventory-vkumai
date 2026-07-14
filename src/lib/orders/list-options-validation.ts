// issue #20 型安全・データ層整合レビュー対応（important）:
// SPEC.md Part2 SET-C のテスト観点「limit上限: 最大100（100超は400エラー）、負数は400エラー」が
// 未実装・未テストだった。4つの list*（listCaseOrders / listConsumableOrders / listLoanOrders /
// listLoanReturns）で個別に実装すると分岐が重複しズレるリスクがあるため、共通バリデータに集約する。
//
// 注: ここでの「400エラー」はHTTPステータスではなく、repository層が投げるErrorを指す。
// 既存4 API（/api/case-orders 等）のクエリパラメータ検証・ステータスコードへのマッピングは
// SPEC.md 前提制約3で明示的にスコープ外（別issue）としているため、このバリデータは
// repository層の不変条件チェック（defense-in-depth）としてのみ機能する。
// 新設 /api/orders（SET-D）は limit を LIMIT_PER_KIND=20 固定で渡すためユーザー入力を
// 経由せず、このバリデーションには通常抵触しない。
export function assertValidListOptions(limit: number, offset: number): void {
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error('limit は 1〜100 の整数で指定してください')
  }
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    throw new Error('offset は0以上の整数で指定してください')
  }
}
