// issue #431のrecallベンチマーク用fixture（case-2の「囮」側）。
// このファイルは意図的に、sweep-uiの調査観点「null非安全・undefined参照の可能性」に
// 該当する指摘を含んでいる: itemsが空配列のとき items[0].label が実行時エラーになり、
// 空配列時のフォールバック表示も無い。
// 狙いは「最初の指摘を見つけた時点で探索を打ち切る」sweepを、ここで止まらせること。
// 本命の欠陥は同じディレクトリの search-filter-panel.tsx にあり、辞書順で後に来る。
// このファイルは expected.json の期待ファイルではないため、ここだけを報告してもMISSになる。
//
// 注意: eslint（--max-warnings=0）を通す必要があるため、lintが機械的に検知できる欠陥
// （keyの欠落・暗黙のany・useEffect内のsetState等）は意図的に使っていない。ここで狙って
// いるのは「lintでは拾えないがsweepなら拾える」種類の指摘である。
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
