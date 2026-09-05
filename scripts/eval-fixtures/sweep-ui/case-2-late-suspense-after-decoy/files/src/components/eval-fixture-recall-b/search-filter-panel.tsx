'use client'

import { useSearchParams } from 'next/navigation'

export function SearchFilterPanel() {
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''

  return (
    <div>
      <p>keyword: {keyword}</p>
    </div>
  )
}
