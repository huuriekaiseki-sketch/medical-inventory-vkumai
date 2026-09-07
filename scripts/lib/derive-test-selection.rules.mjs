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
  { key: 'pii-log', label: 'PII のログ流出検査', timing: 'always', commands: ['npm run lint', 'bash scripts/check-pii-leak.test.sh'] },
  { key: 'secret-scan', label: '秘密情報の走査', timing: 'always', commands: ['bash scripts/check-secret-leak.test.sh'] },
  { key: 'security-headers', label: 'セキュリティヘッダ', timing: 'always', commands: ['npm test'] },
  { key: 'timezone', label: '時刻・タイムゾーン', timing: 'always', commands: ['npm test', 'npm run lint'] },
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
  // WHY(毎回): merge=union の重複は「マージした PR」ではなく「次に表を触った PR」で表面化する。
  //      触った人が犯人とは限らないので、変更時ではなく毎回回して早く落とす。
  // WHY(毎回): ルールを外に出す判断はどの PR でも起こりうる。安いので毎回回す。
  { key: 'rule-guard-coverage', label: 'ルールを守る検査の有無', timing: 'always', commands: ['node scripts/lib/check-rule-guard-coverage.mjs --verbose'] },
  { key: 'table-row-duplicates', label: '棚卸し表の行の重複', timing: 'always', commands: ['node scripts/lib/check-table-row-duplicates.mjs'] },

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
    // 2026-09-06: API Route 全メソッドの総当たりは E2E（P-017）が機械化。手動は weak 印と新しい攻撃ベクトルのみ
    commands: ['npx playwright test e2e/api-cross-facility-attack.spec.ts', '(手動) 攻撃表で weak 印の route と新しい攻撃ベクトルを他施設ユーザーで直接呼び、03 欄に記録する'],
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
    trigger: ctx => {
      // migration 本体（.sql）だけを見る。migrations/__tests__/*.test.ts はテストであり RPC の挙動を変えない。
      // 作成 route と画面の送信経路（clientRequestId を送る側）も対象（P-053）
      const hits = anyPath(
        ctx.files,
        /^supabase\/migrations\/[^/]*(order|loan|return|rpc|idempotency)[^/]*\.sql$|^src\/app\/api\/(case-orders|loan-orders|consumable-orders|loan-returns)\/route\.ts$|^src\/lib\/client-request-id\.ts$/i,
      )
      const hit = ctx.risks.includes('retry_possible') || hits.length > 0
      return { hit, why: ctx.risks.includes('retry_possible') ? 'リスク申告 retry_possible' : `注文・返却系の RPC / 作成 route / 鍵の検査に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '注文・返却系の RPC / 作成 route に触れておらず、retry_possible の申告も無い',
    commands: ['npm run test:integration', 'npx vitest run src/app/api/__tests__/orders-client-request-id.test.ts'],
  },
  {
    key: 'invariants',
    label: '業務不変条件（DB 制約）',
    timing: 'on-change',
    trigger: ctx => {
      // 不変条件を守るのは DB（migration）で、破る側の入口は発注・返却・価格のリポジトリ
      const hits = anyPath(ctx.files, /^supabase\/migrations\/[^/]*\.sql$|^src\/lib\/(loan-orders|case-orders|consumable-orders|loan-returns|hospital-prices)\/|^src\/lib\/invariant-error\.ts$|^docs\/agents\/invariant-catalog\.md$/)
      return { hit: hits.length > 0, why: `不変条件を守る migration か、破る側の入口に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: 'migration・発注/返却/価格のリポジトリ・不変条件カタログに触れていない',
    commands: ['npm run test:integration', 'bash scripts/check-invariant-catalog.test.sh'],
  },
  {
    key: 'concurrency',
    label: '同時実行',
    timing: 'on-change',
    trigger: ctx => {
      // 更新経路を持つのは現状 hospital_prices（楽観ロック、P-052）と loan_returns（UNIQUE、P-050）。
      // その migration・リポジトリ・route に触れたら並列更新のテストを回す
      const hits = anyPath(ctx.files, /^supabase\/migrations\/[^/]*(order|loan|return|inventory|stock|price)[^/]*\.sql$|^src\/lib\/hospital-prices\/|^src\/app\/api\/hospital-prices\//i)
      const hit = ctx.risks.includes('contention') || hits.length > 0
      return { hit, why: ctx.risks.includes('contention') ? 'リスク申告 contention' : `同一行を並列更新しうる箇所に触れた: ${hits.join(', ')}` }
    },
    notRequiredReason: '同一注文・同一在庫行を複数ユーザーが更新する変更ではなく、contention の申告も無い',
    commands: ['npm run test:integration', '(新しい更新経路を足したら) 同一行を並列更新し、楽観ロック・一意制約の拒否を統合テストで Assert する'],
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
    key: 'flaky',
    label: 'フレーキー検知',
    timing: 'milestone',
    event: '週次 cron（自動。日曜 20:00 UTC）。同時実行・冪等性の統合テストや検知スクリプト自体に触れた PR は手元で回す',
    // 揺れやすい統合テスト（並列・同時送信）と検知の仕組み自体に触れた PR はローカル実行に昇格させる
    trigger: ctx => {
      const hits = anyPath(
        ctx.files,
        /^supabase\/__tests__\/integration\/[^/]*(concurrency|idempotency)[^/]*\.ts$|^scripts\/check-flaky-tests\.sh$|^scripts\/lib\/flaky-[^/]+\.(mjs|sh)$|^\.github\/workflows\/flaky-detection\.yml$/,
      )
      return { hit: hits.length > 0, why: `揺れやすいテストか検知の仕組みに触れた: ${hits.join(', ')}` }
    },
    commands: ['bash scripts/check-flaky-tests.sh --runs 3 --config vitest.integration.config.ts', 'bash scripts/check-flaky-tests.test.sh'],
  },
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
    event: '依存 major 更新、外部公開前',
    // 認可・認証・MFA の判定材料を取る箇所（fail-open 棚卸しの対象）に触れた PR は手元実行に昇格
    trigger: ctx => {
      const hits = anyPath(
        ctx.files,
        /^src\/proxy\.ts$|^src\/lib\/(admin-status|admin-auth)\.ts$|^src\/lib\/supabase\/require-[^/]+\.ts$|^src\/hooks\/useFacilityRole\.ts$|^src\/app\/(mfa-challenge|account\/mfa)\/|^docs\/agents\/fail-open-inventory\.md$/,
      )
      const hit = ctx.risks.includes('external_side_effect') || hits.length > 0
      return { hit, why: ctx.risks.includes('external_side_effect') ? 'リスク申告 external_side_effect' : `認可・認証・MFA の判定材料を取る箇所に触れた: ${hits.join(', ')}` }
    },
    commands: ['bash scripts/check-fail-open.test.sh', 'npx vitest run src/__tests__/proxy.test.ts src/lib/supabase/__tests__ src/lib/__tests__/admin-status.test.ts'],
  },
  { key: 'runbook', label: '復旧手順（ランブック）', timing: 'milestone', event: '障害発生時、公開前' },
  { key: 'scale-measurement', label: '規模の実測', timing: 'milestone', event: '索引・スキーマの変更、依存の major 更新、外部公開前' },
]

// --risk で申告できるキー。test-matrix.md のトリガー列と対応
export const RISK_KEYS = ['authz_change', 'retry_possible', 'contention', 'external_side_effect']

// どのルールにも触れず、かつ製品コード・テスト・文書として素性が分かるパス以外は
// 「未分類」として人に見せる（新しい層が増えたのにルールが無い、を気づかせるため）
export const CLASSIFIED_PATH_PATTERNS = [
  /^src\//, /^supabase\//, /^e2e\//, /^scripts\//, /^docs\//, /^\.claude\//, /^\.codex\//, /^\.agents\//,
  /^\.github\//, /^public\//, /^(package|package-lock|tsconfig[^/]*|vitest[^/]*|playwright[^/]*|eslint[^/]*|next[^/]*)\.(json|ts|js|mjs|cjs)$/,
  /^(CLAUDE|AGENTS|README)\.md$/, /^\.gitignore$/, /^\.env\.example$/,
  // 導入先アダプター設定（issue #420 v1 セット B）。TRI/RISK 語彙・ロール名・コマンドを持つ。
  // 変更時は「ワークフロー同期テスト」（aidd-config.test.js が LOCAL_RISK_CONFIG との一致を検査）が
  // 毎回 required なので、専用の種別は設けない
  /^aidd\.config\.json$/,
  // プラグイン v1 の生成物（issue #420 セット C）。正本は .claude/ と scripts/ で、そちらの変更が
  // 各種別を要求する。生成物の鮮度は scripts/build-plugin.test.sh（hook 回帰、毎回）が --check で見る
  /^dist\/plugins\//,
]
