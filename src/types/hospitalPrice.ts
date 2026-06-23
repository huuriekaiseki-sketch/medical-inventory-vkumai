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
}
