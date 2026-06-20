export type Category = {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export type CategoryInput = {
  name: string
  description: string | null
}
