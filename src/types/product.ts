export type Product = {
  id: string
  jan: string
  ref: string
  name: string
  maker: string | null
  createdAt: string
  updatedAt: string
}

export type ProductInput = {
  jan: string
  ref: string
  name: string
  maker?: string | null
}
