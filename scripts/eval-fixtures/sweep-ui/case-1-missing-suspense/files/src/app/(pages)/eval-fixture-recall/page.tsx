'use client'

import { useSearchParams } from 'next/navigation'

export default function EvalFixtureRecallPage() {
  const searchParams = useSearchParams()
  const filter = searchParams.get('filter') ?? 'all'

  return (
    <div>
      <p>filter: {filter}</p>
    </div>
  )
}
