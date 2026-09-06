export type HospitalPrice = {
  id: string
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
  grossProfit: number
  purchaseRate: number | null
  deliveryRate: number | null
  createdAt: string
  updatedAt: string
}

export type HospitalPriceInput = {
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
  /**
   * 楽観ロック（P-052）。更新時に「読み込んだときの updatedAt」を渡すと、その後に他の利用者が
   * 更新していた場合は 409 で拒否され、後勝ちの上書きにならない。省略時は従来どおり無条件更新。
   */
  expectedUpdatedAt?: string
}
