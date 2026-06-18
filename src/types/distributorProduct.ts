export type DistributorProduct = {
  id: string
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  category: string
  createdAt: string
  updatedAt: string
}

export type DistributorProductInput = {
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  category: string
}
