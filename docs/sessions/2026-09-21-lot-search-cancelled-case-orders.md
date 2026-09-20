# 2026-09-21 ロット検索で、取り消された症例発注に印を出す（issue #824）

## 30秒サマリー

- 変更概要: ロット検索の結果で、取り消された症例発注に「取り消し済み／実際には使用されていない可能性があります」の印を出す。症例発注の詳細ページにも同じ意味を足す（決定A）
- リスク: 低（読み取りのみ。RLS・migration・認可のいずれにも触れていない）
- 変更領域: UI / ロジック（データ取得層）/ 型
- 証拠状態: 実測 6 件 / サンプル・未検証 0 件
- 影響範囲: `/facilities/[id]/lot-search` と `/facilities/[id]/case-orders/[orderId]` の表示。API の形は型が広がるだけで互換
- ロールバック可能性: 高（このPRを revert するだけ。DBもスキーマも触っていない）

レビューしてほしい点:

1. **文言の使い分け**が正しいか。短貸返却は「実際には返却されていない可能性があります」（院内に残っている）、症例発注は「実際には使用されていない可能性があります」（その患者は無関係かもしれない）。担当者が取る行動が逆向きなので分けた
2. **症例発注の取り消しを1段だけで判定している**こと。`case_order_items` に status 列が無いため、短貸返却の2段（明細ごと／回ごとの OR）を写していない

## 00 目的・影響範囲・対象外

- 目的: ロット検索はリコール対応（「このロットをどの患者に使ったか」の特定）の画面。取り消された症例発注は「実際には使っていないかもしれない」のに、印なしで使った記録として並んでいた。読み違えると無関係の患者を巻き込む
- 変更範囲: 型（`LotSearchCaseOrderItem.cancelled`）/ データ取得層（SELECT に `case_orders.status` を足し `cancelled` を返す）/ 画面2つ
- 対象外（今回あえて触らない）:
  - RLS・ポリシー・migration（`case_orders.status` の `'cancelled'` は `20260908070000` で追加済み。DB側は既に準備できていた）
  - API route（型が広がるだけで透過）
  - 短貸返却側のロジック・文言（既存のまま）
  - 絞り込み（取り消し済みを**落とさない**。落とすと「記録はあったが取り消された」が見えなくなる）
- 作業中に見つけた別件:
  - **AIDD の feature 名が揃わない**: Phase 1 の light ルートの sweep 4体が全員バラバラの feature 名を使った（`issue-824` / `issue #824` / `issue #824 lot search cancelled case orders` / `824`）。phase2 の18体は全員正しい名前。#823 は deep ルートを直したので、`aidd-phase1.js`（light）に同じ穴が残っている。**C-047（直した門を隣へ広げていない）の型**（issue 未起票・ユーザー確認待ち）
  - **gap check state がフェーズを跨げない**: Stop hook は「expected が記録済みなら gap check を実行して state を削除する」が、CLAUDE.md は「フェーズごとに expected を加算」と指示している。Phase 1 の expected を記録した時点でターンが終わると state が消え、Phase 2 の加算が「before 値が未記録」で弾かれる（実際に弾かれた）（issue 未起票・ユーザー確認待ち）
  - **E-092 の3回目の再発**: `core.hooksPath` が存在しない絶対パスを指しており、commit-msg も pre-push も動いていなかった。このセッション冒頭で復旧済み（詳細は下記「このセッションで直した別件」）
  - **`audit_log` の積み上がり**: `table_name=loan_returns` が 1009 行で E-022/E-023 の閾値（800）超え。`supabase db reset` が必要
- 依存の変更: なし

## 01 画面がどう変わったか（UI証拠）

スクリーンショットは未取得（**サンプル・図解ではなく未取得**。下記は差分から起こした説明）。

**ロット検索** `src/app/facilities/[id]/lot-search/page.tsx`

既存の短貸返却の印と同じ位置（種別列の下）・同じ赤文字（`#B91C1C`）・同じマークアップで、症例発注用の分岐を追加。文言のみ変えている。

```
症例発注
  取り消し済み                              ← 追加
  実際には使用されていない可能性があります    ← 追加
短貸返却
  取り消し済み                              ← 既存（変更なし）
  実際には返却されていない可能性があります    ← 既存（変更なし）
```

**症例発注の詳細ページ** `src/app/facilities/[id]/case-orders/[orderId]/page.tsx`

事実だけだった表示に、意味を足した（決定A）。

```
Before: この発注は取り消されています
After:  この発注は取り消されています
        実際には使用されていない可能性があります    ← 追加
```

## 02 内部でどう守っているか（ロジック証拠）

- `src/types/order.ts` — `LotSearchCaseOrderItem` に `cancelled: boolean` を追加
- `src/lib/lot-search/repository.ts`
  - `CaseOrderParentRow` に `status?: unknown`
  - `searchCaseOrderItems` の `.select()` に `case_orders.status` を追加
  - `mapCaseOrderItem` に `cancelled: asString(parent?.status) === 'cancelled'`
  - **1段だけで判定する**理由をコメントに明記（`case_order_items` に status 列が無く、2段の OR を写すと存在しない列を読んで常に false 側へ倒れる）
- 絞り込みには使っていないので、件数・`truncated` 判定・並び順は変わらない

**守りの2段は維持**: 症例発注の行に医師名・性別・術式名を載せない制約は、型に無い（コンパイル時）／SELECT で問い合わせない（実行時）の2段のまま。`status` は個人情報ではなく取り消し判定にのみ使う旨をコメントに明記した。

## 03 誰が操作できるか（RLS/権限証拠）

- **RLS・権限の変更点: なし**。ポリシーも migration も触っていない
- 他テナントのIDでアクセスし、弾かれることを確認したか: **確認済み（既存テストの再実行）**。`lot-search-rls-idor.integration.test.ts` の既存ケース（他施設の一般メンバーが施設Aを指定しても0件 / admin が施設Bを指定しても施設Aが混ざらない）が、今回の変更後も実DBで緑
- 該当する約束: **P-013**（明細は親経由で施設スコープ）/ **P-015**（自施設は取得できる・対照）。いずれも既存の約束で、新しい約束は作っていない

## 04 どう確認したか（テスト・検証）

`bash scripts/derive-test-selection.sh origin/main --format table` の出力に実施結果を反映した。

| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 | ✅ 実施（自動テスト: パス） | `npx tsc --noEmit` exit 0 |
| lint | ✅ 実施（自動テスト: パス） | `npm run lint` exit 0 |
| unit（UI・データ層・API Route） | ✅ 実施（自動テスト: パス） | `npm test` → 262 files / **2465 passed**（変更前 2463。追加2件ぶん増） |
| build | ✅ 実施（自動テスト: パス） | `npm run build` exit 0 |
| migration 静的テスト | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| DB 制約 ratchet | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| PII のログ流出検査 | ✅ 実施（自動テスト: パス） | `npm run lint` に含まれる |
| 秘密情報の走査 | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| セキュリティヘッダ | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| 時刻・タイムゾーン | ✅ 実施（自動テスト: パス） | `npm test` / `npm run lint` に含まれる |
| ワークフロー同期テスト | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| hook 回帰 | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| 認証ファイル漏洩チェック | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| 依存監査（既知脆弱性） | ➖ 今回不要 | package.json / package-lock.json に触れていない |
| ロックファイルの出所 | ➖ 今回不要 | 同上 |
| docs 整合性 | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| ルールを守る検査の有無 / 効いているか | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| ロードマップの状態の鮮度 | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| 棚卸し表の行の重複 | ✅ 実施（自動テスト: パス） | `npm test` に含まれる |
| RLS/IDOR 統合（実 DB） | ✅ 実施（自動テスト: パス） | `npm run test:integration` → 51 files / **396 passed / 1 skipped**、消し残し0件、`logs/integration-runs.jsonl` に pass を記録 |
| 生成型の鮮度 | ✅ 実施（自動テスト: パス） | `bash scripts/check-generated-supabase-types.sh` → up to date |
| 直接攻撃の実測（テスト外） | ✅ 実施（自動テスト: パス） | `npx playwright test e2e/api-cross-facility-attack.spec.ts` → **1 passed**（「全 route × 全メソッドを施設 B のユーザーで叩いても、施設 A のデータは漏れず・変わらない [P-017]」）。429 は出なかった（1 worker 実行） |
| 依存差分レビュー / agents baseline 鮮度 / ワークフロープロンプト eval / hook 実機発火 | ➖ 今回不要 | package.json・.claude/agents・.claude/workflows・hook スクリプトのいずれにも触れていない |
| 冪等性（再送・二重実行） | ➖ 今回不要 | 注文・返却系の RPC / 作成 route に触れておらず、retry_possible の申告も無い |
| 業務不変条件（DB 制約） | ➖ 今回不要 | migration・発注/返却/価格のリポジトリ・不変条件カタログに触れていない |
| 同時実行 | ➖ 今回不要 | 同一注文・同一在庫行を複数ユーザーが更新する変更ではなく、contention の申告も無い |
| E2E（Playwright 全体） | ➖ 今回不要 | 節目の種別（main マージ後に自動）。`e2e/` に触れていない |
| スキーマドリフト / フレーキー / fault injection / 障害注入 / 復旧手順 / 規模の実測 | ➖ 今回不要 | いずれも節目の種別で、該当する節目に当たらない |

### この変更に直接対応するテスト

- `src/lib/lot-search/__tests__/repository.test.ts`
  - 「症例発注の取り消し状態を case_orders.status の1段だけで判定する」（`cancelled` / `submitted` / `draft` の3ケース）
  - 「症例発注の SELECT は患者 ID・イニシャルと取り消し判定用の status を親から取り、医師名・性別・術式名は問い合わせない」（**今回強化**）
- `supabase/__tests__/integration/lot-search-rls-idor.integration.test.ts`
  - 「取り消し済みの症例発注の明細は、落とさずに cancelled=true で返る（対照: 取り消していない明細は false）」（実DB・**一般メンバー** `userA`・出荷関数 `searchLotItems` を呼ぶ）
- `src/app/facilities/[id]/case-orders/[orderId]/__tests__/page.test.tsx`
  - 「取り消し済みのとき、事実だけでなく『実際には使用されていない可能性があります』と意味まで出す」（返却側の文言に取り違えられたら落ちる）
  - 「取り消していない発注には、取り消しの文言を出さない（対照）」
- `src/app/facilities/[id]/lot-search/__tests__/page.test.tsx` — 症例発注の取り消し印

`npm run ai:check` は**実行していない**（E2E 全体を含むため）。代わりに構成要素（typecheck / lint / test / test:integration / build）を個別に実行し、上表に結果を記した。

### fault injection（C-022: 壊して落ちることを確かめる）

**実施した。** `searchCaseOrderItems` の `.select()` から `status` を1箇所だけ外して測った。

| 壊した箇所 | モックテスト | 統合テスト |
|---|---|---|
| SELECT から `status` を削除 | ❌ 1件 failed（SELECT の中身を見る検証） | ❌ 1件 failed（`cancelled: false` が返る） |

復旧後、両方とも緑に戻ることを確認した（モック18件 / 統合11件）。

**この実測に意味があった**: SELECT を壊しても `it.each` の cancelled 判定テスト17件は**緑のまま通った**。モックが返す行に `status` を含めているため。SELECT の中身を直接見る検証を足していなければ、モック側は誰も気づけない状態だった。実際、実装中に data-impl が「型と map だけ足されて SELECT が据え置かれ、`cancelled` が常に false」というバグを踏んでいる。

### 証拠の実測/サンプル区分

| 証拠 | 区分 |
|---|---|
| 02 ロジック | 実測（差分そのもの） |
| 03 RLS | 実測（統合テスト再実行） |
| 04 型検査・lint・unit・build | 実測（コマンド実行の exit code） |
| 04 統合テスト | 実測（`logs/integration-runs.jsonl` に記録） |
| 04 fault injection | 実測（壊して失敗を確認し、戻して緑を確認） |
| 01 UI | **未取得**（スクリーンショット無し。差分からの説明） |

`verify-claims` による検証は**実施していない**。上の数値はすべてこのセッション内のコマンド実行結果から直接引いている。

## 05 何かあったらどうするか（観測・ロールバック）

- リリース後に見るログ/メトリクス: 特になし（読み取りのみ・外部送信なし）
- 異常の判断基準: ロット検索で、取り消していない症例発注にまで「取り消し済み」が出る（＝判定の反転）。逆に、取り消した症例発注に印が出ない
- ロールバック手順: このPRを revert する。DBもスキーマも触っていないのでデータ移行は不要

## 後任AIへの注意

- **この実装で壊してはいけない前提**:
  - 取り消し済みを**検索結果から落とさない**。印を付けるだけ。落とすと「記録はあったが取り消された」が見えなくなる
  - 症例発注の行に医師名・性別・術式名を載せない。守りは型（コンパイル時）と SELECT（実行時）の2段
  - `searchCaseOrderItems` の `.order()` は `case_datetime`。ここを別の列に変えると `truncated` 判定の前提が崩れる（元からの制約）
- **似ているが別物の用語**:
  - 症例発注の取り消しは**1段**（`case_orders.status` だけ）。短貸返却は**2段**（明細ごと `loan_return_items.status` と回ごと `loan_returns.status` の OR）。`case_order_items` に status 列は**無い**
  - 文言も別物。返却は「返却されていない」、発注は「使用されていない」
- **勝手にリファクタしない場所**:
  - `mapCaseOrderItem` と `mapLoanReturnItem` の共通化。判定の段数が違うので、まとめると片方が壊れる
  - `repository.ts` の `.select()` 文字列。列を足すと「載せない」制約が崩れる。テストが SELECT の中身を直接見ているので落ちるはずだが、足す前に理由を書くこと

---

## このセッションで直した別件: E-092（git hook の無音素通り）

**3回目の再発**（2026-09-13 / 2026-09-18 / 今回）。`core.hooksPath` が worktree スコープと local スコープの両方で、存在しない絶対パス `/Users/masanori/medical-inventory-vkumai/scripts/git-hooks` を指していた（メインチェックアウトは Jul 21 で止まっており `git-hooks/` がまだ無い）。git は存在しない hooksPath を**黙って無視する**ため、commit-msg も pre-push も動いていなかった。

対処:

1. `git config --worktree --unset core.hooksPath`
2. `git config --unset core.hooksPath`（local の絶対パスも削除）
3. `bash scripts/install-git-hooks.sh` で**相対パス** `scripts/git-hooks` に入れ直し

**RED 方向で実測**: ESC バイト（0x1b）を含むメッセージで `git commit --allow-empty` → exit 1 で停止、HEAD 不変。`pre-push` は未実測（実際に push しないと動かないため）。

**書き込み元は特定できていない**。`install-git-hooks.sh` は相対パスで書き、`create-worktree.sh` も Claude の設定ファイルも `hooksPath` に触れていない。他の worktree には同じ上書きは残っていなかった。
