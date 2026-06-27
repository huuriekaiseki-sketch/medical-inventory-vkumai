'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import type { HospitalPriceInput } from '@/types/hospitalPrice'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'

type HospitalPriceFormProps = {
  facilities: Facility[]
  distributorProducts: DistributorProduct[]
  defaultValues?: HospitalPriceInput
  onSubmit: (data: HospitalPriceInput) => Promise<void>
  submitLabel?: string
}

export function HospitalPriceForm({
  facilities,
  distributorProducts,
  defaultValues,
  onSubmit,
  submitLabel = '保存',
}: HospitalPriceFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const noFacilities = facilities.length === 0
  const noProducts = distributorProducts.length === 0
  const submitDisabled = noFacilities || noProducts || isSubmitting

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    setSubmitError(null)
    setIsSubmitting(true)
    try {
      await onSubmit({
        facilityId: (formData.get('facilityId') as string) ?? '',
        distributorProductId: (formData.get('distributorProductId') as string) ?? '',
        purchasePrice: Number(formData.get('purchasePrice')),
        deliveryPrice: Number(formData.get('deliveryPrice')),
      })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {submitError && (
        <p role="alert" className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {submitError}
        </p>
      )}
      <div>
        <label htmlFor="facilityId" className="block text-sm font-medium text-gray-700">
          施設
        </label>
        {noFacilities ? (
          <p className="mt-1 text-sm text-gray-700">
            施設が登録されていません。
            <Link href="/facilities" className="text-blue-600 hover:text-blue-800">
              先に施設を登録してください
            </Link>
          </p>
        ) : (
          <select
            id="facilityId"
            name="facilityId"
            required
            defaultValue={defaultValues?.facilityId ?? ''}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>
              選択してください
            </option>
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label htmlFor="distributorProductId" className="block text-sm font-medium text-gray-700">
          代理店商品
        </label>
        {noProducts ? (
          <p className="mt-1 text-sm text-gray-700">
            代理店商品が登録されていません。先に代理店商品を登録してください。
          </p>
        ) : (
          <select
            id="distributorProductId"
            name="distributorProductId"
            required
            defaultValue={defaultValues?.distributorProductId ?? ''}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>
              選択してください
            </option>
            {distributorProducts.map((dp) => (
              <option key={dp.id} value={dp.id}>
                {dp.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label htmlFor="purchasePrice" className="block text-sm font-medium text-gray-700">
          仕切値（円）
        </label>
        <input
          id="purchasePrice"
          name="purchasePrice"
          type="number"
          min="0"
          step="1"
          required
          defaultValue={defaultValues?.purchasePrice ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="deliveryPrice" className="block text-sm font-medium text-gray-700">
          納品価格（円）
        </label>
        <input
          id="deliveryPrice"
          name="deliveryPrice"
          type="number"
          min="0"
          step="1"
          required
          defaultValue={defaultValues?.deliveryPrice ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={submitDisabled}
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </form>
  )
}
