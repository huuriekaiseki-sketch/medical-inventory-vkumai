# SPEC: 消耗品(consumables)登録のデッドAPI解消とseed.sql整備の方針決定(Issue #647)

## Part 1 — 仕様(★人間がレビューする部分)

### 背景・調査結果

1. **消耗品登録POSTがデッドAPI**
   - `src/app/api/consumables/route.ts` の POST(`createConsumable`)は施設スコープの認可(`requireFacilityAccess`)・バリデーション・リポジトリ層まで実装済み
   - 実際の消耗品発注フローは `src/app/facilities/[id]/consumable-orders/new/page.tsx` で、GETで一覧取得するのみで登録UIが存在しない
   - (訂正: 当初この背景で言及していた`ConsumableOrderModal.tsx`は、調査時点で既にアプリのどこからも参照されていない未使用コンポーネントだった。実際に使われているのは`new/page.tsx`の方であり、モーダルは今回の対応でファイルごと削除した)
   - 結果として、実運用では**施設ユーザーが消耗品を1件も登録できず**、発注画面は「消耗品が登録されていません」という空状態のまま発注不能になる(DBに直接データを入れない限り機能しない)
   - e2eテストにもconsumables関連のカバレッジは無し

2. **`supabase/seed.sql` 不在**
   - `supabase db reset` 後は空のDBになる
   - 一方で `supabase/__tests__/integration/helpers/seed-rls-idor.ts` というテストヘルパー方式が既に確立されており、4つのRLS/IDOR統合テスト(case/consumable/loan-orders/loan-returns)で運用中

### 方針決定(提案)

1. **消耗品登録UIを追加する**(POST削除ではなくUI追加)
   - 理由: これは単なるデッドコード掃除ではなく、機能として未完成の状態(発注機能の前提となるマスタ登録手段が欠落)。既存のPOST実装(認可・バリデーション込み)を活かせる
   - 施設ごとにスコープされたシンプルな登録フォーム(品名・JAN・用途)を、消耗品発注ページ(`/facilities/[id]/consumable-orders`)に追加する
   - products(グローバルadmin限定マスタ)とは異なり、consumablesは施設メンバーなら誰でも登録可能(既存API設計を踏襲)

2. **seed.sqlは新規作成せず、既存のテストヘルパー方式を正式設計として文書化する**
   - 理由: 既に確立され4箇所で運用実績のあるパターンがあるため、別方式(seed.sql)を並存させると二重管理になる
   - `docs/agents/decisions.md`に「なぜseed.sqlではなくテストヘルパー方式を採用するか」を記録する

### 受け入れ条件

- [x] `/facilities/[id]/consumable-orders` ページに消耗品登録フォーム(品名必須・JAN任意・用途必須)が追加されている
- [x] 登録後、同ページ内の「登録済みの消耗品」一覧に反映される(かつ`new/page.tsx`の発注選択リストにも次回取得時に反映される)
- [x] 他施設の消耗品は見えない・登録できない(既存のfacility-scope認可を維持)
- [x] 品名・用途が空白のみの場合は400エラーになる(既存API側バリデーションと整合するUI側チェック)
- [x] `docs/agents/decisions.md`に、seed.sqlを作らずテストヘルパー方式を正式採用する旨の決定が追記されている

## Part 2 — 実装計画

### Set A: 消耗品登録UI
- `src/components/orders/ConsumableRegisterForm.tsx`(新規): 品名・JAN・用途の入力フォーム。送信で`POST /api/consumables`を呼ぶ
- `src/app/facilities/[id]/consumable-orders/page.tsx`: 登録フォームを配置し、登録成功時に一覧を再取得する
- テスト: フォームの必須項目バリデーション・送信成功時の一覧更新・エラー表示

### Set B: seed方針の文書化
- `docs/agents/decisions.md`に決定理由を追記(コードマイグレーション不要)
