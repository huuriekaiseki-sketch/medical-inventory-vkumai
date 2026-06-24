# 施設詳細ページ 発注・処理ボタン設計書

**日付**: 2026-06-24  
**対象ページ**: `/facilities/[id]`  
**ステータス**: 承認済み

---

## Part 1: 機能概要（人間レビュー用）

### 背景・目的

施設詳細ページに発注・貸出処理のアクションボタンを追加する。
医療現場での機器・消耗品の発注フローをシステム化し、事務担当者への引き渡しをスムーズにする。

### 追加するボタン（5種類）

| ボタン | 色 | 今回の実装 |
|---|---|---|
| 症例発注 | オレンジ | フル実装 |
| 消耗品発注 | グリーン | フル実装 |
| 短貸発注 | ブルー | フル実装 |
| 短貸返却 | グレー | フル実装 |
| 長貸し処理 | グレー（無効） | ボタンのみ（「準備中」表示） |

### UIフロー

- 各ボタンをクリックするとモーダルが開く
- 長貸し処理のみ「現在準備中」のトーストを表示
- モーダル内でフォーム入力 → 送信 → DBへ保存

### 各モーダルの入力項目

#### 症例発注
- 症例日時（日付・時刻）
- 手技名
- 患者ID
- 患者イニシャル
- 性別（男・女・その他）
- 担当医師名
- 使用物品（複数行）：JAN / LOT / UBD / 数量

#### 消耗品発注
- 前提：施設ごとの消耗品カタログ（`consumables`）から選択
- 用途カテゴリでフィルタリング
- 各消耗品にチェック＋数量入力
- カタログ未登録の場合は「消耗品を追加」で登録可能

#### 短貸発注
- 手技名（テキスト入力）
- メーカー名（テキスト入力）
- 発注物品リスト（複数行）：JAN / 品名 / 数量

#### 短貸返却
- 返却日時
- 返却物品（複数行）：JAN / LOT / UBD / 数量

#### 長貸し処理
- ボタンのみ。クリック時に「現在準備中です」トーストを表示

### バージョンアップ計画（スコープ外）

- v2：iPhoneカメラによるバーコード（JAN）スキャン
- v3：カメラ撮影によるOCR自動解析（JAN / LOT / UBD）

---

## Part 2: 技術詳細（レビュー不要）

### データベース設計

```sql
-- 症例発注ヘッダー
CREATE TABLE case_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  case_datetime TIMESTAMPTZ NOT NULL,
  procedure_name TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  patient_initials TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  doctor_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 症例発注明細
CREATE TABLE case_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_order_id UUID NOT NULL REFERENCES case_orders(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 消耗品カタログ（施設ごとのマスタ）
CREATE TABLE consumables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  jan TEXT,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 消耗品発注ヘッダー
CREATE TABLE consumable_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 消耗品発注明細
CREATE TABLE consumable_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumable_order_id UUID NOT NULL REFERENCES consumable_orders(id) ON DELETE CASCADE,
  consumable_id UUID NOT NULL REFERENCES consumables(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸発注ヘッダー
CREATE TABLE loan_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  procedure_name TEXT NOT NULL,
  maker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸発注明細
CREATE TABLE loan_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_order_id UUID NOT NULL REFERENCES loan_orders(id) ON DELETE CASCADE,
  jan TEXT,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸返却ヘッダー
CREATE TABLE loan_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  return_datetime TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'returned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸返却明細
CREATE TABLE loan_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_return_id UUID NOT NULL REFERENCES loan_returns(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### ファイル構成

```
src/
  types/
    order.ts                          # CaseOrder, ConsumableOrder, LoanOrder, LoanReturn 型
  lib/
    case-orders/repository.ts         # create, listByFacility
    consumables/repository.ts         # create, listByFacility
    consumable-orders/repository.ts   # create, listByFacility
    loan-orders/repository.ts         # create, listByFacility
    loan-returns/repository.ts        # create, listByFacility
  app/api/
    case-orders/route.ts              # POST
    consumables/route.ts              # GET, POST
    consumable-orders/route.ts        # POST
    loan-orders/route.ts              # POST
    loan-returns/route.ts             # POST
  components/orders/
    OrderButtons.tsx                  # 5ボタン群（クライアントコンポーネント）
    CaseOrderModal.tsx                # 症例発注モーダル
    ConsumableOrderModal.tsx          # 消耗品発注モーダル
    LoanOrderModal.tsx                # 短貸発注モーダル
    LoanReturnModal.tsx               # 短貸返却モーダル
    ItemRowInput.tsx                  # JAN/LOT/UBD/数量の共通行入力コンポーネント
  app/facilities/[id]/page.tsx        # OrderButtons を追加
supabase/migrations/
  20260624000000_add_orders.sql
```

### 並列実装グループ

**Wave 1（依存なし・同時実装可能）**
- G1: DBマイグレーション + 型定義（`order.ts`）
- G2: 症例発注 Repository + API + Modal（TDD）
- G3: 消耗品カタログ + 消耗品発注 Repository + API + Modal（TDD）
- G4: 短貸発注 Repository + API + Modal（TDD）
- G5: 短貸返却 Repository + API + Modal（TDD）

**Wave 2（Wave 1完了後）**
- G6: `OrderButtons.tsx` 統合 + 施設詳細ページへ組み込み + 全テスト確認

### テスト方針

- 各 Repository：Supabase インラインモックパターン（既存テストに倣う）
- 各 Modal：React Testing Library でフォーム入力・送信・エラー表示をカバー
- API routes：fetch モックで正常系・異常系

### 型定義概要（`src/types/order.ts`）

```typescript
// 症例発注
export type CaseOrder = { id: string; facilityId: string; caseDatetime: string; procedureName: string; patientId: string; patientInitials: string; gender: 'male' | 'female' | 'other'; doctorName: string; status: 'draft' | 'submitted'; items: CaseOrderItem[]; createdAt: string; updatedAt: string }
export type CaseOrderItem = { id: string; caseOrderId: string; jan: string; lot?: string; ubd?: string; quantity: number }

// 消耗品
export type Consumable = { id: string; facilityId: string; name: string; jan?: string; purpose: string; createdAt: string; updatedAt: string }
export type ConsumableOrder = { id: string; facilityId: string; status: 'draft' | 'submitted'; items: ConsumableOrderItem[]; createdAt: string; updatedAt: string }
export type ConsumableOrderItem = { id: string; consumableOrderId: string; consumableId: string; quantity: number }

// 短貸発注
export type LoanOrder = { id: string; facilityId: string; procedureName: string; maker: string; status: 'draft' | 'submitted'; items: LoanOrderItem[]; createdAt: string; updatedAt: string }
export type LoanOrderItem = { id: string; loanOrderId: string; jan?: string; name: string; quantity: number }

// 短貸返却
export type LoanReturn = { id: string; facilityId: string; returnDatetime: string; status: 'draft' | 'returned'; items: LoanReturnItem[]; createdAt: string; updatedAt: string }
export type LoanReturnItem = { id: string; loanReturnId: string; jan: string; lot?: string; ubd?: string; quantity: number }
```
