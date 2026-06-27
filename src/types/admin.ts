export type AdminUser = {
  id: string
  email: string
  lastSignInAt: string | null
  facilityIds: string[]
}

export type Facility = {
  id: string
  name: string
}
