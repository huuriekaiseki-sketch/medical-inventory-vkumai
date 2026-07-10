export const meta = {
  name: 'aidd-phase1-router',
  description: 'taskDescriptionをTRI/RISK基準に照合し、aidd-phase1（軽量Sweep）とaidd-1-1-deep-task（深掘り）のどちらを起動するか自動判定する。',
  whenToUse: 'Phase 1調査の入り口として使う。DBスキーマ変更・auth/facility/tenant/organization/inventory/RLS/policy等の高リスク判定を機械的に行い、手動判断を不要にする。',
  phases: [
    { title: 'Route', detail: 'TRI/RISKキーワード照合で軽量/深掘りを判定' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number }
// 判定はtaskDescriptionのキーワードマッチのみ（変更ファイル・git diffは見ない）

const RISK_KEYWORDS = [
  // パス由来
  'migrations', 'migration', 'マイグレーション', 'スキーマ',
  'src/lib/supabase', 'middleware.ts', 'ミドルウェア',
  // ドメイン由来（common.md TRI/RISK基準）
  'auth', '認証', 'ログイン',
  'facility', '施設',
  'tenant', 'テナント',
  'organization', '組織',
  'inventory', '在庫',
  'rls', 'policy', 'ポリシー',
]

// 意図的に安全側に倒す（common.md TRI/RISK原則: 迷ったら高リスク側）。
// false positive（軽微なタスクが深掘りに回る＝時間コスト増）は許容し、
// false negative（高リスク変更を軽量版で見逃す）は許容しない。

// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への回避策。
// argsが文字列で届いた場合はJSONとしてパースしてから使う。
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

const taskDescription = parsedArgs?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = parsedArgs?.maxRounds ?? 3

phase('Route')

const lowerTask = taskDescription.toLowerCase()
const matched = RISK_KEYWORDS.filter(kw => lowerTask.includes(kw.toLowerCase()))
const isHighRisk = matched.length > 0

log(
  isHighRisk
    ? `TRI/RISK該当キーワード検出（${matched.join(', ')}）→ aidd-1-1-deep-task を起動`
    : 'TRI/RISK該当なし → aidd-phase1（軽量Sweep）を起動'
)

const result = isHighRisk
  ? await workflow('aidd-1-1-deep-task', { taskDescription, maxRounds })
  : await workflow('aidd-phase1', { taskDescription })

return {
  route: isHighRisk ? 'aidd-1-1-deep-task' : 'aidd-phase1',
  matchedKeywords: matched,
  result,
}
