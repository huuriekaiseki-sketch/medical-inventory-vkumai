export type Product = {
  id: string
  name: string
  code: string
  category: string
  unit: string
  unitPrice: number | null
  createdAt: string
  updatedAt: string
}

export type ProductInput = {
  name: string
  code: string
  category: string
  unit: string
  unitPrice: number | null
}
