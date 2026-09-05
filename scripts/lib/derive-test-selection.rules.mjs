// 必須テスト機械導出（derive）の「このリポジトリ固有」部分。
//
// WHY: docs/agents/test-matrix.md の各行（テスト種別）に derive キーを1つ割り当て、
//      「変更ファイル一覧 → 今回必須 / 今回不要（理由付き）」の対応をここに閉じ込める。
//      エンジン（derive-test-selection.mjs）はこの表だけを読み、パス表を持たない。
//      派生リポジトリへ持っていくときは、このファイルだけを書き換える（形式は共通、中身は固有）。
//
//      高リスクパス（supabase/migrations・src/lib/supabase・proxy.ts・auth/facility/... を含む
//      パス）の判定は .claude/workflows/lib/router-risk.js の classifyRoute を正本とし、
//      ここに同じパス表を並行で持たない（kojigyo-zei-rag の bash case 表で乖離した反省。
//      docs/agents/decisions.md「なぜテスト一覧…を後続PRに分けたか」参照）。
//
// 各ルールの形:
//   key       test-matrix.md の「derive キー」列と 1:1
//   label     04 表の「種別」欄にそのまま貼る文言（test-matrix.md の種別名に揃える）
//   timing    'always'（毎回: CI が全 PR で回す）/ 'on-change'（変更時）/ 'milestone'（節目）
//   trigger   on-change のみ。(ctx) => { hit: boolean, why: string } を返す。
//             ctx = { files, route, risks }。route は classifyRoute の戻り値
//   notRequiredReason  on-change で hit しなかったときに 04 表の「➖ 今回不要」に貼る理由
//   commands  ローカルで実行するコマンド（手動のものは "(手動) ..."）
//   event     milestone のみ。いつ回すか
//   status    test-matrix.md の状態が ⬜ 未整備 の種別は 'not-ready'（required になっても
//             「種別が未整備なので個別テストで代替する」注記を付ける）

const HIGH_RISK_DESC =
  '高リスクパス（supabase/migrations・src/lib/supabase・proxy.ts、または auth/facility/tenant/organization/inventory/rls/policy を含むパス）'

const anyPath = (files, re) => files.filter(f => re.test(f))

const highRiskHit = ctx => ctx.route.matchedPaths.length > 0
const integrationGateHit = ctx =>
  highRiskHit(ctx) ||
  anyPath(ctx.files, /^supabase\/__tests__\//).length > 0 ||
  ctx.files.includes('.github/workflows/integration-gate.yml')

export const RULES = [
  // ---- 毎回（CI が全 PR で自動）。理由は「毎回」で固定 ----
  { key: 'typecheck', label: '型検査', timing: 'always', commands: ['npm run typecheck'] },
  { key: 'lint', label: 'lint', timing: 'always', commands: ['npm run lint'] },
  { key: 'unit', label: 'unit（UI・データ層・API Route）', timing: 'always', commands: ['npm test'] },
  { key: 'build', label: 'build', timing: 'always', commands: ['npm run build'] },
  { key: 'migration-static', label: 'migration 静的テスト', timing: 'always', commands: ['npm test'] },
  { key: 'constraint-ratchet', label: 'DB 制約 ratchet', timing: 'always', commands: ['npm test', 'bash scripts/check-constraint-coverage.sh'] },
  { key: 'workflow-sync', label: 'ワークフロー同期テスト', timing: 'always', commands: ['npm test'] },
  {
    key: 'hook-regression',
    label: 'hook 回帰',
    timing: 'always',
    // 変更した hook スクリプトに対応する *.test.sh を名指しで出す（全件は CI hooks-test が回す）
    commands: ctx => {
      const own = anyPath(ctx.files, /^scripts\/(lib\/)?[^/]+\.sh$/)
        .filter(f => !f.endsWith('.test.sh'))
        .map(f => `bash ${f.replace(/\.sh$/, '.test.sh')}`)
      const tests = anyPath(ctx.files, /^scripts\/(lib\/)?[^/]+\.test\.sh$/).map(f => `bash ${f}`)
      return [...new Set([...own, ...tests])]
    },
  },
  { key: 'auth-file-leak', label: '認証ファイル漏洩チェック', timing: 'always', commands: ['git ls-files e2e/.auth'] },
  { key: 'dependency-audit', label: '依存監査（既知脆弱性）', timing: 'always', commands: ['npm audit --omit=dev --audit-level=high'] },
  { key: 'lockfile-integrity', label: 'ロックファイルの出所', timing: 'always', commands: ['bash scripts/check-lockfile-integrity.test.sh'] },
  { key: 'docs-integrity', label: 'docs 整合性', timing: 'always', commands: ['node scripts/lib/check-docs-integrity.mjs'] },

  // ---- 変更時 ----
  {
    key: 'dependency-diff-review',
    label: '依存差分レビュー',
    timing: 'on-change',
    trigger: ctx => {
      const hits = ctx.files.filter(f => /(^|\/)package(-lock)?\.json$/.test(f))
      return { hit: hits.length > 0, why: `依存関係ファイルに触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: 'package.json / package-lock.json に触れていない',
    commands: [
      'git diff origin/main -- package.json',
      'npm ci --dry-run',
      'npm audit --omit=dev --audit-level=high',
      '(手動) 追加・更新した各パッケージの用途・代替案・権限/環境変数/DB への影響・固定版と出所・ロールバックを 00 欄「依存の変更」に書く。見覚えのない間接依存は npm explain <pkg> で起点を辿る',
    ],
  },
  {
    key: 'rls-idor-integration',
    label: 'RLS/IDOR 統合（実 DB）',
    timing: 'on-change',
    trigger: ctx => ({
      hit: integrationGateHit(ctx) || ctx.risks.includes('authz_change'),
      why: highRiskHit(ctx)
        ? `${HIGH_RISK_DESC}に触れた: ${ctx.route.matchedPaths.join(', ')}`
        : ctx.risks.includes('authz_change')
          ? 'リスク申告 authz_change'
          : 'supabase/__tests__ または integration-gate.yml に触れた',
    }),
    notRequiredReason: `${HIGH_RISK_DESC}に触れていない（integration-gate.yml の paths 条件に該当せず）`,
    commands: ['npm run test:integration'],
  },
  {
    key: 'generated-types',
    label: '生成型の鮮度',
    timing: 'on-change',
    trigger: ctx => ({ hit: integrationGateHit(ctx), why: 'RLS/IDOR 統合と同じ paths 条件' }),
    notRequiredReason: 'RLS/IDOR 統合と同じ paths 条件に該当せず（DB スキーマに触れていない）',
    commands: ['bash scripts/check-generated-supabase-types.sh'],
  },
  {
    key: 'direct-attack',
    label: '直接攻撃の実測（テスト外）',
    timing: 'on-change',
    trigger: ctx => ({
      hit: highRiskHit(ctx) || ctx.risks.includes('authz_change'),
      why: highRiskHit(ctx) ? `auth / 認可 / RLS に関わるパスに触れた: ${ctx.route.matchedPaths.join(', ')}` : 'リスク申告 authz_change',
    }),
    notRequiredReason: 'auth / 認可 / RLS に関わるパスに触れていない',
    commands: ['(手動) 他施設ユーザーで API Route / RPC を直接呼び、拒否を確認して 03 欄に記録する'],
  },
  {
    key: 'agents-baseline',
    label: 'agents baseline 鮮度',
    timing: 'on-change',
    trigger: ctx => {
      const hits = anyPath(ctx.files, /^\.claude\/(agents|workflows)\//)
      return { hit: hits.length > 0, why: `.claude/agents または .claude/workflows に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '.claude/agents・.claude/workflows に触れていない',
    commands: ['(自動) PR で agent-baseline-check.yml が警告する。model / effort を変えたら docs/agents/baselines/ に before スナップショットを置く'],
  },
  {
    key: 'workflow-eval',
    label: 'ワークフロープロンプト eval',
    timing: 'on-change',
    trigger: ctx => {
      const hits = anyPath(ctx.files, /^\.claude\/workflows\//)
      return { hit: hits.length > 0, why: `.claude/workflows に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '.claude/workflows に触れていない',
    commands: ['bash scripts/eval-workflow-prompts.sh <fixture>'],
  },
  {
    key: 'hook-live',
    label: 'hook 実機発火',
    timing: 'on-change',
    trigger: ctx => {
      const hits = [
        ...anyPath(ctx.files, /^scripts\/(lib\/)?[^/]+\.sh$/).filter(f => !f.endsWith('.test.sh')),
        ...ctx.files.filter(f => f === '.claude/settings.json' || f === '.codex/hooks.json'),
      ]
      return { hit: hits.length > 0, why: `hook / settings に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: 'hook スクリプト・.claude/settings.json・.codex/hooks.json に触れていない',
    commands: ['(手動) 新規セッションで hook 発火を確認する（Codex 側 hook は Codex セッションでも確認）'],
  },
  {
    key: 'idempotency',
    label: '冪等性（再送・二重実行）',
    timing: 'on-change',
    status: 'not-ready',
    trigger: ctx => {
      // migration 本体（.sql）だけを見る。migrations/__tests__/*.test.ts はテストであり RPC の挙動を変えない
      const hits = anyPath(ctx.files, /^supabase\/migrations\/[^/]*(order|loan|return|rpc)[^/]*\.sql$/i)
      const hit = ctx.risks.includes('retry_possible') || hits.length > 0
      return { hit, why: ctx.risks.includes('retry_possible') ? 'リスク申告 retry_possible' : `注文・返却系 RPC の migration に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '注文・返却系 RPC に触れておらず、retry_possible の申告も無い',
    commands: ['(個別テスト) 同じ入力で RPC を2回呼び、件数・状態が変わらないことを統合テストで Assert する'],
  },
  {
    key: 'concurrency',
    label: '同時実行',
    timing: 'on-change',
    status: 'not-ready',
    trigger: ctx => {
      const hits = anyPath(ctx.files, /^supabase\/migrations\/[^/]*(order|loan|return|inventory|stock)[^/]*\.sql$/i)
      const hit = ctx.risks.includes('contention') || hits.length > 0
      return { hit, why: ctx.risks.includes('contention') ? 'リスク申告 contention' : `同一注文・同一在庫行を更新しうる migration に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '同一注文・同一在庫行を複数ユーザーが更新する変更ではなく、contention の申告も無い',
    commands: ['(個別テスト) 同一行を並列更新し、楽観ロック・一意制約の拒否を統合テストで Assert する'],
  },

  // ---- 節目（PR ごとには要求しない。いつ回すかだけ出す） ----
  {
    key: 'e2e',
    label: 'E2E（Playwright）',
    timing: 'milestone',
    event: 'main マージ後（自動）。e2e/ に触れた PR はローカルで実行',
    // e2e/ を触った PR はローカル実行を required に昇格させる
    trigger: ctx => {
      const hits = anyPath(ctx.files, /^e2e\//)
      return { hit: hits.length > 0, why: `e2e/ に触れた: ${hits.join(', ')}` }
    },
    commands: ['npm run test:e2e'],
  },
  { key: 'schema-drift', label: 'スキーマドリフト検知', timing: 'milestone', event: '日次 cron（自動）' },
  {
    key: 'fault-injection-drill',
    label: 'fault injection 訓練（ゲート）',
    timing: 'milestone',
    event: '四半期、または aidd-phase2.js の Spec Check / Manifest Check プロンプト変更時',
    trigger: ctx => ({ hit: ctx.files.includes('.claude/workflows/aidd-phase2.js'), why: 'aidd-phase2.js に触れた' }),
    commands: ['(手動) docs/agents/fault-injection-drill.md の手順'],
  },
  {
    key: 'fault-injection',
    label: '障害注入（外部依存停止）',
    timing: 'milestone',
    status: 'not-ready',
    event: '依存 major 更新、外部公開前',
    trigger: ctx => ({ hit: ctx.risks.includes('external_side_effect'), why: 'リスク申告 external_side_effect' }),
    commands: ['(個別テスト) Supabase 停止・タイムアウト時に UI / API Route が失敗を返すことを Assert する'],
  },
  { key: 'runbook', label: '復旧手順（ランブック）', timing: 'milestone', event: '障害発生時、公開前' },
]

// --risk で申告できるキー。test-matrix.md のトリガー列と対応
export const RISK_KEYS = ['authz_change', 'retry_possible', 'contention', 'external_side_effect']

// どのルールにも触れず、かつ製品コード・テスト・文書として素性が分かるパス以外は
// 「未分類」として人に見せる（新しい層が増えたのにルールが無い、を気づかせるため）
export const CLASSIFIED_PATH_PATTERNS = [
  /^src\//, /^supabase\//, /^e2e\//, /^scripts\//, /^docs\//, /^\.claude\//, /^\.codex\//, /^\.agents\//,
  /^\.github\//, /^public\//, /^(package|package-lock|tsconfig[^/]*|vitest[^/]*|playwright[^/]*|eslint[^/]*|next[^/]*)\.(json|ts|js|mjs|cjs)$/,
  /^(CLAUDE|AGENTS|README)\.md$/, /^\.gitignore$/, /^\.env\.example$/,
]
