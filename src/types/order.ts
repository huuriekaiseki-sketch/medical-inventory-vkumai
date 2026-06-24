export type CaseOrder = {
  id: string
  facilityId: string
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  status: 'draft' | 'submitted'
  items: CaseOrderItem[]
  createdAt: string
  updatedAt: string
}

export type CaseOrderItem = {
  id: string
  caseOrderId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type CaseOrderInput = {
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  items: CaseOrderItemInput[]
}

export type CaseOrderItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}

export type Consumable = {
  id: string
  facilityId: string
  name: string
  jan?: string
  purpose: string
  createdAt: string
  updatedAt: string
}

export type ConsumableInput = {
  name: string
  jan?: string
  purpose: string
}

export type ConsumableOrder = {
  id: string
  facilityId: string
  status: 'draft' | 'submitted'
  items: ConsumableOrderItem[]
  createdAt: string
  updatedAt: string
}

export type ConsumableOrderItem = {
  id: string
  consumableOrderId: string
  consumableId: string
  quantity: number
  createdAt: string
}

export type ConsumableOrderInput = {
  items: ConsumableOrderItemInput[]
}

export type ConsumableOrderItemInput = {
  consumableId: string
  quantity: number
}

export type LoanOrder = {
  id: string
  facilityId: string
  procedureName: string
  maker: string
  status: 'draft' | 'submitted'
  items: LoanOrderItem[]
  createdAt: string
  updatedAt: string
}

export type LoanOrderItem = {
  id: string
  loanOrderId: string
  jan?: string
  name: string
  quantity: number
  createdAt: string
}

export type LoanOrderInput = {
  procedureName: string
  maker: string
  items: LoanOrderItemInput[]
}

export type LoanOrderItemInput = {
  jan?: string
  name: string
  quantity: number
}

export type LoanReturn = {
  id: string
  facilityId: string
  returnDatetime: string
  status: 'draft' | 'returned'
  items: LoanReturnItem[]
  createdAt: string
  updatedAt: string
}

export type LoanReturnItem = {
  id: string
  loanReturnId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type LoanReturnInput = {
  returnDatetime: string
  items: LoanReturnItemInput[]
}

export type LoanReturnItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}
