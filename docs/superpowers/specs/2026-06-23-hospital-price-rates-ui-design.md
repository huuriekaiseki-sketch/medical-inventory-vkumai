# Design: HospitalPriceList への掛け率列追加

Date: 2026-06-23

## 背景

前回セッション（2026-06-23）でDBマイグレーションが完了し、`hospital_prices` テーブルに以下の3カラムが追加・デプロイ済み：

- `gross_profit` — 生成列（`delivery_price - purchase_price`）
- `purchase_rate` — トリガー管理（`purchase_price / reimbursement_price`）
- `delivery_rate` — トリガー管理（`delivery_price / reimbursement_price`）

今回はこれらをフロントエンドに表示する。

## スコープ

`/hospital-prices` の一覧画面（`HospitalPriceList`）に以下の列を追加する：

| 列 | 表示内容 | null時 |
|---|---|---|
| 粗利（円） | DBの `gross_profit` 値（円） | — （発生しない） |
| 仕入れ掛け率 | `purchaseRate × 100`、小数点1桁（例: 80.0%） | — |
| 納入掛け率 | `deliveryRate × 100`、小数点1桁（例: 96.0%） | — |

粗利は従来インライン計算（`deliveryPrice - purchasePrice`）だったが、DB値に切り替える。

## アーキテクチャ

### 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/types/hospitalPrice.ts` | `HospitalPrice` 型に3フィールド追加 |
| `src/lib/hospital-prices/repository.ts` | `mapHospitalPrice` でDBカラムをマッピング |
| `src/components/hospitalPrices/HospitalPriceList.tsx` | 表示列を更新 |
| `src/components/hospitalPrices/__tests__/` | テスト更新・追加 |

### 型定義変更

```ts
export type HospitalPrice = {
  // ... 既存フィールド ...
  grossProfit: number          // DB: gross_profit（生成列、常にnon-null）
  purchaseRate: number | null  // DB: purchase_rate（reimbursementPrice未設定時null）
  deliveryRate: number | null  // DB: delivery_rate（reimbursementPrice未設定時null）
}
```

### リポジトリ変更

`mapHospitalPrice` に追記：

```ts
grossProfit: Number(row.gross_profit),
purchaseRate: row.purchase_rate != null ? Number(row.purchase_rate) : null,
deliveryRate: row.delivery_rate != null ? Number(row.delivery_rate) : null,
```

### UI変更

- 粗利列: `price.grossProfit.toLocaleString()` に切替（インライン計算から変更）
- 仕入れ掛け率列: `purchaseRate != null ? (purchaseRate * 100).toFixed(1) + '%' : '—'`
- 納入掛け率列: `deliveryRate != null ? (deliveryRate * 100).toFixed(1) + '%' : '—'`

## テスト方針

- `HospitalPriceList` の既存テストを新フィールドに対応
- `purchaseRate`/`deliveryRate` が null の場合に「—」が表示されることを確認
- `purchaseRate`/`deliveryRate` が存在する場合に % 表示されることを確認

## 受け入れ条件

- [ ] 粗利列がDB値（`grossProfit`）を表示する
- [ ] 仕入れ掛け率列が追加され、`purchaseRate × 100` を小数点1桁の%表示
- [ ] 納入掛け率列が追加され、`deliveryRate × 100` を小数点1桁の%表示
- [ ] `purchaseRate`/`deliveryRate` が null の場合「—」表示
- [ ] 既存テストがすべて通過する
- [ ] 新規テストが追加される
