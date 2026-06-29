'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ItemRowInput, type ItemRow } from '@/components/orders/ItemRowInput'

export default function NewCaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [caseDatetime, setCaseDatetime] = useState('')
  const [procedureName, setProcedureName] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientInitials, setPatientInitials] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male')
  const [doctorName, setDoctorName] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!procedureName.trim()) { setError('手技名を入力してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/case-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          caseDatetime,
          procedureName,
          patientId,
          patientInitials,
          gender,
          doctorName,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/case-orders`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
  const inputClass = 'border rounded px-3 py-2 text-sm w-full'
  const inputStyle = { borderColor: '#E5E7EB' }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/case-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 症例発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>New Case Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          症例発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="caseDatetime" className={labelClass} style={labelStyle}>症例日時 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="caseDatetime" type="datetime-local" value={caseDatetime} onChange={e => setCaseDatetime(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="patientId" className={labelClass} style={labelStyle}>患者ID <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="patientId" type="text" value={patientId} onChange={e => setPatientId(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="patientInitials" className={labelClass} style={labelStyle}>患者イニシャル <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="patientInitials" type="text" value={patientInitials} onChange={e => setPatientInitials(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="gender" className={labelClass} style={labelStyle}>性別 <span style={{ color: '#DC2626' }}>*</span></label>
          <select id="gender" value={gender} onChange={e => setGender(e.target.value as 'male' | 'female' | 'other')} className={inputClass} style={inputStyle}>
            <option value="male">男</option>
            <option value="female">女</option>
            <option value="other">その他</option>
          </select>
        </div>
        <div className="mb-4">
          <label htmlFor="doctorName" className={labelClass} style={labelStyle}>担当医師 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="doctorName" type="text" value={doctorName} onChange={e => setDoctorName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-6">
          <p className={labelClass} style={labelStyle}>使用物品</p>
          <ItemRowInput rows={items} onChange={setItems} />
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/case-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#FF5F03' }}>
            {submitting ? '送信中...' : '発注する'}
          </button>
        </div>
      </form>
    </div>
  )
}
