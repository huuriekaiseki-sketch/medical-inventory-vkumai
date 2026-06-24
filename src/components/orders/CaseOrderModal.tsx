'use client'

import { useState } from 'react'
import { ItemRowInput, type ItemRow } from './ItemRowInput'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function CaseOrderModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [caseDatetime, setCaseDatetime] = useState('')
  const [procedureName, setProcedureName] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientInitials, setPatientInitials] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male')
  const [doctorName, setDoctorName] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = () => {
    setCaseDatetime('')
    setProcedureName('')
    setPatientId('')
    setPatientInitials('')
    setGender('male')
    setDoctorName('')
    setItems([{ jan: '', lot: '', ubd: '', quantity: 1 }])
    setError(null)
  }

  const handleClose = () => { resetForm(); onClose() }

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/case-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          caseDatetime,
          procedureName,
          patientId,
          patientInitials,
          gender,
          doctorName,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || '送信に失敗しました')
      }
      resetForm()
      onSuccess()
      onClose()
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>症例発注</h2>
          <button type="button" onClick={handleClose} style={{ color: '#6B7280' }}>✕</button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
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
            <button type="button" onClick={handleClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#FF5F03' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
