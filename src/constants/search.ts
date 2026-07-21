// WHY: キーワード検索のデバウンス値。OrderHistoryFilters.tsx・ProductSearchFilters.tsx・
//      DistributorProductSearchFilters.tsx で同一の300msが個別に定義されていたため、
//      統合ゲート（Phase4）で仕様変更時の修正漏れを防ぐために共有定数へ切り出した
//      （SPEC.md Part2 Set E-1参照）。
export const KEYWORD_DEBOUNCE_MS = 300
