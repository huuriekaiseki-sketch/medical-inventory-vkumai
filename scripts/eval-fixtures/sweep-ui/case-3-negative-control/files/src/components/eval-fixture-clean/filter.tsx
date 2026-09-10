'use client'

import { useSearchParams } from 'next/navigation'

export function EvalFixtureCleanFilter() {
  const searchParams = useSearchParams()
  const filter = searchParams.get('filter') ?? 'all'

  return <p>filter: {filter}</p>
}
