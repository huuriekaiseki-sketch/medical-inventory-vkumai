export type HospitalPrice = {
  id: string
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
  createdAt: string
  updatedAt: string
}

export type HospitalPriceInput = {
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
}
