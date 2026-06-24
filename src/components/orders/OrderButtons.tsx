'use client'

import { useState } from 'react'
import { CaseOrderModal } from './CaseOrderModal'
import { ConsumableOrderModal } from './ConsumableOrderModal'
import { LoanOrderModal } from './LoanOrderModal'
import { LoanReturnModal } from './LoanReturnModal'

type Modal = 'case' | 'consumable' | 'loan' | 'loanReturn' | null

type Props = {
  facilityId: string
}

export function OrderButtons({ facilityId }: Props) {
  const [openModal, setOpenModal] = useState<Modal>(null)

  const btnBase = 'px-4 py-2 text-sm font-semibold rounded text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-8">
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#FF5F03' }}
          onClick={() => setOpenModal('case')}
        >
          症例発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#16A34A' }}
          onClick={() => setOpenModal('consumable')}
        >
          消耗品発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#2563EB' }}
          onClick={() => setOpenModal('loan')}
        >
          短貸発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#4B5563' }}
          onClick={() => setOpenModal('loanReturn')}
        >
          短貸返却
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#9CA3AF' }}
          disabled
        >
          長貸し処理
        </button>
      </div>

      <CaseOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'case'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <ConsumableOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'consumable'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <LoanOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'loan'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <LoanReturnModal
        facilityId={facilityId}
        isOpen={openModal === 'loanReturn'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
    </>
  )
}
