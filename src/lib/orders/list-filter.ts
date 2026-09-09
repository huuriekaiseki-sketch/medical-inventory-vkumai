import { z } from 'zod'
import { paginationQueryShape } from '@/lib/api-pagination'

// WHY: dateFrom/dateTo/keyword の3フィールドだけを持つフィルタ型（CaseOrderListFilter /
//      ConsumableOrderListFilter / LoanOrderListFilter / LoanReturnListFilter）が
//      各 repository ファイルに構造的に同一のまま4箇所で重複定義されていた
//      （issue #20 レビュー指摘: 型安全・データ層の整合 minor / 重複・過剰実装）。
//      src/types/order.ts の OrderListFilter（kind を含む横断用の契約）とは責務が異なるため
//      統合できないが、単一種別 repository 用のフィルタ型は1箇所にまとめて重複を解消する。
export type OrderRepositoryFilter = {
  dateFrom?: string
  dateTo?: string
  keyword?: string
}

// WHY: keyword絞り込みはDB側のilike/AND条件だけではitems配列との「OR一致」を表現できないため、
//      各 repository は keyword 指定時に .range() を外して全件取得し、JS側でOR一致判定してから
//      offset/limitを適用する設計になっている。この「全件取得」に上限が無いと、施設の発注件数が
//      増えるほど1リクエストで取得・保持する行数が際限なく増大し、DoSベクタになる
//      （issue #20 レビュー指摘: 正しさ important）。orders/repository.ts の KIND_LIMIT (500) と
//      同じ考え方で、keyword絞り込み時のスキャン対象にも上限を設ける。
export const KEYWORD_SCAN_LIMIT = 500

// WHY(2026-09-09、クエリを唯一の入口へ): 症例発注・消耗品発注・短貸発注・返却の一覧 route は、
//      **まったく同じ形**でクエリを読んでいた——`facility_id` を生読みし、
//      ページ送りだけ `parsePagination` に渡す。4 か所に同じ数行が並んでいた。
//      `parseQuery` へ移すのに合わせて、その形もここへ 1 つにまとめる。
//
// WHY(facility_id は長さだけ見る): 越境そのものは所属判定（`requireFacilityAccess`）と RLS が止める。
//      ここで UUID の形まで縛ると、既存の単体テストが使う短い ID（`f1` など）が落ちる。
//      **入口で締めるかどうかはテストの書き換えとセットの判断**なので、この移行では長さだけにする。
export const orderListQuerySchema = z.object({
  facility_id: z.string().max(200, { error: 'facility_id が長すぎます' }).optional(),
  ...paginationQueryShape(),
})
