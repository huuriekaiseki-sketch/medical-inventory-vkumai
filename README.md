# medical-inventory-vkumai

医療機器在庫管理システム — 熊井フレームワーク（並列ループエージェント）学習用リポジトリ

## 技術スタック

- Next.js (App Router)
- Supabase (PostgreSQL)
- Vitest
- TypeScript

## フレームワーク

熊井さん「Claude Codeでつくる『並列ループエージェント』実践ハンズオンガイド」をベースに構築。

5フェーズ: 調査(並列) → 仕様書 → [人間レビュー] → 実装(TDD・並列) → 統合ゲート → 検証(並列) → [構造化レビュー]

## 2026-06-17 の学び（Day 6 / OBL6）

### やったこと
- 熊井フレームワーク5フェーズを1サイクル完走
- implementerサブエージェント4体で並列TDD実装
- テスト40件全パス、ビルド成功
- reviewerが4観点で並列レビュー → バグ4件検出・修正
- ブラウザで製品マスタCRUD動作確認OK

### 気づき
- サブエージェント4体並列が実際に動く。ファイル独立の並列グループ宣言が衝突防止の鍵
- 「使える」と「わかって使える」は別。回せたが中身の理解はこれから
- 仕様駆動（SPEC.md）の重要性：Part 1で人間がレビュー、Part 2でAIが実装する分離構造
- レビューフェーズは形式的ではなく実効性がある（unitPrice=0→null等の実バグが見つかった）

### 次のステップ
- `/goal` サーキットブレーカーの実践
- 同じフレームワークで2〜3周目を回す
- Supabase実接続に差し替え
- GitHub Issues + CI/CD を組み込む
- 守 → 破：フレームワークの設計意図を理解して自分の案件に合わせて変える

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Test

```bash
npm test
```
