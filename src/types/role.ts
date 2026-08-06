// WHY: 施設ロールのリテラル型・許可リストが複数箇所に重複コピーされ、#601でviewerロールを
// 追加した際にasEnumの許可リスト更新漏れによる誤表示バグが2回(別セッションで)発生した
// (issue #609, #608実装時)。ここに一元化し、新しいロールを追加する際はこのファイルの
// 変更だけで済むようにする(残りの参照箇所は型エラーとして機械的に列挙される)。
export const FACILITY_ROLES = ['admin', 'staff', 'viewer'] as const

export type FacilityRole = (typeof FACILITY_ROLES)[number]
