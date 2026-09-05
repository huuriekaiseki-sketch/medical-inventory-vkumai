'use client'

type AlertBannerProps = {
  items: { label: string }[]
}

export function AlertBanner({ items }: AlertBannerProps) {
  return (
    <div>
      <p>{items[0].label}</p>
    </div>
  )
}
