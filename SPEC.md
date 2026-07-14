# 機能仕様書 — issue #20: 発注履歴ページ（/orders）: 4種別の発注を横断して一覧・検索

> ステータス: **承認済み（停止①クリア）— Phase 3実装へ**
> 作成日: 2026-07-14 / 承認日: 2026-07-14
> 由来: Phase 1深掘り調査（Sweep→Draft Spec→Find→Adversarial Verify→Completeness Critic→Judge Panel→Synthesize、92エージェント）の統合提案
> 承認内容: 判断が必要な点6点すべて回答済み（未返却バッジ見送り・80件固定表示・先頭施設デフォルト・単純ilike・総件数非表示、②は保留でよい）。実装時の技術的懸念2点（summaryLabelのJOIN経路・facility_id自動送信ロジック）もSPEC.mdに反映済み
> 前提: issue #23（分析・レポート `/reports`）はissue自身が「本issue完了後に着手推奨（案5）」としており、本issueはその前提条件

---

## Part 1 — 仕様（★人間がレビューする部分）

### 背景・課題

発注登録モーダル（症例出荷・消耗品・貸出・返却）とDB・RPCは実装済みだが、それらを横断して参照する一覧ページが存在しない。施設ごとの個別ページ（`/facilities/[id]/case-orders` 等）はあるが、種別をまたいだ検索・一覧性がない。

### 何ができるようになるか（利用者目線）

- `/orders` を開くと、自施設に関係する4種別の発注（症例発注・消耗品発注・貸出発注・貸出返却）を1つの表で時系列に確認できる
- 画面上部のフィルタで「期間」「製品名」「発注種別」を絞り込める
- 管理者は施設フィルタも使用でき、複数施設をまたいで確認できる
- 各行から関連する既存ページへ遷移できる（※実装時に判明した齟齬: 個別レコード単位の詳細ページは現行コードベースに存在しないため、施設スコープの一覧ページ（例: `/facilities/{facilityId}/loan-orders`）へのリンクとして実装。単票詳細ページの新設要否は別issueで検討）

### v1スコープで**やらないこと**（Phase 1調査でコードレベルの矛盾が確定したため除外）

- **貸出の「未返却」バッジ表示** — issue原文の要件だが、下記「判断が必要な点①」に理由を記載。v1では見送り、別issueで再検討
- **「さらに読み込む」による追加ページネーション** — 各種別最新20件（計最大80件）の固定表示に変更。理由は「判断が必要な点③」参照
- **JAN（バーコード）での製品検索** — 品名検索のみに統一。理由は下記
- 発注詳細の編集・削除
- CSVエクスポート

### 操作の流れ

1. サイドバー等から「発注履歴」を開く → `/orders` に遷移
2. 施設スコープで最新80件（種別ごと最新20件ずつ）の発注が日付降順で表示される
3. フィルタ変更 → URLクエリパラメータ更新 → 再フェッチ
4. 各行の「詳細」から該当施設・種別の一覧ページに遷移（上記「利用者目線」の※注記参照）

### 受け入れ条件（チェックリスト）

#### 表示
- [ ] case_orders / consumable_orders / loan_orders / loan_returns の4種別が1テーブルに表示される（各種別最新20件、計最大80件、`displayDatetime`降順・同時刻は`id`を第2キーに安定ソート）
- [ ] 表示カラム: 発注日時・種別ラベル（症例発注/消耗品発注/貸出発注/貸出返却）・ステータス・製品名（主要1品＋残n件）・施設名（adminのみ）
- [ ] 空結果時は「該当する発注履歴がありません」を表示

#### フィルタ
- [ ] 期間フィルタ（date_from/date_to）: `CaseOrder→case_datetime` / `ConsumableOrder・LoanOrder→created_at` / `LoanReturn→return_datetime` で絞り込む。境界は両端とも含む（`gte`/`lte`）。日付単位で選択されたJST日付は「選択日 00:00:00+09:00」（date_from）〜「選択日 23:59:59.999+09:00」（date_to、選択日を含む終端）としてUTC変換した上でAPIへ渡す（変換はSET-Fのクライアント側で行い、API層では変換しない。前提制約参照）
- [ ] 製品フィルタ（product_search）: 品名の部分一致（ilike）のみ。JAN検索は対象外
- [ ] 種別フィルタ（order_type）: チェックボックスで複数選択（デフォルト全選択）。`order_kinds`に`OrderKind`以外の未知の値が1つでも含まれる場合はリクエスト全体を400で拒否する（黙って無視すると意図しない種別で絞り込まれたことに呼び出し元が気づけないため）
- [ ] 施設フィルタ（adminのみ表示）: 施設ドロップダウン
- [ ] 非adminで所属施設が複数ある場合、施設選択ドロップダウンを表示し、先頭施設を初期選択する（判断が必要な点④参照）。所属施設が1件のみなら自動セットしUI非表示。非adminで所属施設が0件の場合はドロップダウンを出さず「所属施設がありません」を表示し、`/api/orders`へのリクエスト自体を送らない（`facility_id`未確定のままリクエストするとAPI層に400で弾かれ続けるだけで無意味なため）

#### アクセス制御
- [ ] 非adminユーザーは自分が所属する施設のデータのみ閲覧できる
- [ ] 非adminがfacility_id省略・不正指定 → 400、他施設facility_id指定 → 403
- [ ] 未認証 → API層は401を返し、ページ層が/loginへリダイレクトする（責務分離）

#### エラー・ローディングUI
- [ ] 4種別の一部取得に失敗しても、成功した種別は表示する（`Promise.allSettled`）。失敗種別がある場合は「一部の発注種別を取得できませんでした」バナーを表示
- [ ] フィルタ変更中はスケルトンUIを表示
- [ ] APIエラー・ネットワークエラー時はエラーバナー＋リトライボタンを表示

---

### 判断が必要な点（レビュー時に確認）

1. **「未返却」バッジをv1で本当に見送るか**
   Phase 1調査でコード確認済み: `loan_orders.status`の許容値は`['draft','submitted']`のみで`'returned'`は存在せず、`loan_returns`に`loan_order_id`列も無く、`createLoanReturn`は`loan_order.status`を更新しない。つまりissue原文が想定する「未返却ステータス表示」を単純な`status`判定（案A）で実装すると、**返却済みレコードを100%誤検知して常に「未返却」と表示してしまう**バグになることが確定している。
   正確に実装するには`loan_returns`に`loan_order_id`FKを追加するマイグレーション（案B）が必要。
   → **推奨: v1では見送り、案Bを別issueで先行実施してから再度対応**。ただしバッジがビジネス上必須なら、本issueのスコープを広げて案Bを含める判断もありうる

2. **既存`loan_returns`データの案B移行戦略**（①で案B採用の場合のみ関係）
   FK後付け時、既存レコードの`loan_order_id`をNULLのまま残すか、lot/jan/facilityで推測紐付けするか。データ整合性に関わるため人間判断が必要（v1では扱わないため今回は保留でよい）

3. **ページネーションをv1で「各種別最新20件・計最大80件の固定表示」に絞ることの受容**
   種別ごとにoffsetを取ると全体の日付降順マージと矛盾し重複・抜けが確定的に発生するため、cursor-basedページネーションが必要になるが、v1にはコストが見合わない。この制約（それより古いデータは期間フィルタで絞り込む必要がある）を運用上許容できるか

4. **複数施設所属ユーザーのデフォルト施設**
   「先頭施設を初期選択」でよいか、「前回選択を復元」等の要望があるか

5. **製品フィルタのスペース区切りOR検索の要否**
   単純な部分一致（ilike）のみで十分か、複数キーワードのOR検索に対応するか（対応する場合UIヘルプテキストが追加で必要）

6. **総件数表示は不要か**
   「全n件中m件表示」等の件数表示要件は無しとする前提（`counts`フィールドを削除）で問題ないか

---

## Part 2 — 実装計画（AI用・技術詳細）

### 前提制約（調査結果から）

1. **facility_id必須制約**: `requireFacilityAccess`は非adminでfacility_id=nullを拒否する。新規APIエンドポイント（`/api/orders`）ではadmin時のみfacility_id=nullを許可し、非adminは所属施設のfacility_idを解決して渡す
2. **RLSは追加不要**: `20260628010001_update_rls_admin.sql`で4テーブルに`facility_member_or_admin`ポリシーが存在済み。`/api/orders`は`requireFacilityAccess`を呼ぶだけでRLSが自動適用される（API側チェックはdefense-in-depth）
3. **既存4 APIのクエリパラメータバリデーション漏れ**（`limit`/`offset`のNumber.isFinite・負数・上限チェックなし）のHTTPステータスコードへのマッピングは本issueのスコープ外（別issue推奨、pending_issues.jsonlで追跡）。ただし repository層（SET-C）の list* 関数自体には limit/offset の不変条件チェック（`limit`は1〜100の整数、`offset`は0以上の整数。外れる場合はErrorを投げる）を defense-in-depth として実装する（呼び出し元でのHTTPステータスへの変換は各APIの責務のまま）。新設する`/api/orders`（SET-D）は`limit`をユーザー入力から受け取らず`LIMIT_PER_KIND=20`固定で呼ぶため、この検証には通常抵触しない
4. **use(params) + Suspense**: 新設`/orders`ページは`useSearchParams`を使うため`Suspense`でのラップ＋`fallback`指定が必須（既知の失敗パターン：`src/app/login/page.tsx:110`で同種の指摘あり、本issueでは新規実装側で確実に対応する）
5. **facilityName（admin表示用）の解決元**: `facilities`テーブルは authenticated であれば全件SELECT可能な共有マスタ（`auth_only`ポリシー）。SET-D（`unified-repository.ts`）が`listFacilities(db)`を1回呼び、`id→name`のMapを作って各`UnifiedOrder.facilityName`に適用する。4種別ごとに個別JOINしない（N+1回避）
6. **admin用施設一覧（フィルタドロップダウン・全施設対象時の対象施設ID解決）の取得元**: 既存`GET /api/facilities`は`listFacilities(db)`の全件をそのまま返す仕様で、非adminにも全施設が見えてしまい「非adminは所属施設のみ選択可」という受け入れ条件と矛盾する。そのため`/orders`ページ（SET-F）専用の軽量エンドポイント`GET /api/user-facilities`を新設し、adminには全施設、非adminには`listUserFacilities`で解決した所属施設のみを返す（`{ facilities: Facility[], isAdmin: boolean }`）。既存`GET /api/dashboard`は施設ごとの重い集計を含むため流用しない。同様に、SET-Dの`unified-repository.ts`はサーバー側関数のため`listFacilities`を直接呼べるが、SET-Fはクライアントコンポーネント（`'use client'`）であり`src/lib/facilities/repository.ts`等のサーバー専用DBアクセス関数を直接importできない。そのため両者は独立した経路（サーバー内部呼び出し vs 新設APIのfetch）で施設一覧を取得する

### 実装セット一覧（依存順）に対する補足: `/api/user-facilities`

上記前提制約6により、統合時点で以下のセットを追加実装済み（元のSET-F計画にはAPIエンドポイントの記載が無く、`listUserFacilities`をクライアント側から直接呼ぶ想定になっていたが、クライアントコンポーネントからサーバー専用のrepository関数を直接呼ぶことはできないため、この不足を補うAPIが必要だった）:

- ファイル: `src/app/api/user-facilities/route.ts`（新規）
- GET: `requireAuth`（401） → `resolveIsAdmin` → admin時は`listFacilities`の全件、非admin時は`listUserFacilities`で絞り込んだ所属施設のみを返す
- SET-Fはこのエンドポイントをfetchして`facilities`・`isAdmin`を取得し、施設ドロップダウンの選択肢と初期選択施設を決定する

### 型定義（`src/types/order.ts` に追記）

```typescript
export type OrderKind = 'case' | 'consumable' | 'loan' | 'loan_return'

// raw原案は削除（union型のtype guardが強制されず実行時エラーリスクがあるため）。
// 詳細遷移はid+kindのみで既存個別ページへのリンクで完結する
export type UnifiedOrder = {
  id: string
  kind: OrderKind
  facilityId: string
  facilityName?: string          // admin表示用（JOIN先から）
  displayDatetime: string        // case→case_datetime / consumable・loan→created_at / loan_return→return_datetime。生成責任はAPI層(SET-D)
  status: string
  summaryLabel: string           // 代表製品名 + 残n件。生成責任はAPI層(SET-D)
}

export type OrdersFilter = {
  facilityId?: string
  dateFrom?: string   // ISO 8601 (UTC)
  dateTo?: string     // ISO 8601 (UTC)
  productSearch?: string
  orderKinds?: OrderKind[]
}
```

### 実装セット一覧（依存順）

#### SET-A: DBマイグレーション — インデックス追加
- ファイル: `supabase/migrations/YYYYMMDDHHMMSS_add_orders_search_indexes.sql`
- 追加インデックス:
  - `case_orders`: `(facility_id, case_datetime)` ★既存の`idx_case_orders_facility_created_at`とは別に必要（期間フィルタは`case_datetime`を使うため）
  - `consumable_orders`: `(facility_id, created_at)`
  - `loan_orders`: `(facility_id, created_at)`
  - `loan_returns`: `(facility_id, return_datetime)`
- `refresh_schema_baseline_snapshot`は呼ばない（テーブル追加/削除を伴わないインデックス追加のみのため。common.md記載の対象外。念のためmigration内に1行コメントで根拠を明記する）
- テスト観点: マイグレーション適用が冪等に成功すること（`IF NOT EXISTS`）

#### SET-B: 型定義追加
- ファイル: `src/types/order.ts`（上記型定義を追記）
- 依存: なし（先行実装可）

#### SET-C: Repository層フィルタ拡張
- ファイル（4ファイル）: `src/lib/case-orders/repository.ts` / `src/lib/consumable-orders/repository.ts` / `src/lib/loan-orders/repository.ts` / `src/lib/loan-returns/repository.ts`
- 各`list*`関数に`dateFrom?`, `dateTo?`, `productSearch?`引数を追加
- 品名JOIN経路（M-3・M-5対応。**このJOINはproductSearchフィルタの絞り込み専用**であり、SET-Dが行うsummaryLabel表示用の名前解決とは目的・実行タイミングが異なる別クエリである。両者は同じ`products`/`consumables`テーブルに触れるが、前者は「検索条件に一致するID群を求める」ため、後者は「取得済みレコードの代表製品名を表示用に解決する」ためであり、責務が重複しているわけではない。productSearch未指定時はSET-C側のJOINは発生しない）:
  - `loan_order_items.name`（直接、name列あり）
  - `case_order_items.jan → products.name`（JOIN必須、case_order_itemsにname列なし）
  - `loan_return_items.jan → products.name`（JOIN必須、loan_return_itemsにname列なし）
  - `consumable_order_items.consumable_id → consumables.name`（JOIN）
- 生の`status`をそのまま返す（isUnreturned等の判定はSET-Cでは行わない。将来案B採用時もAPI層1箇所の修正で完結させるため）
- `limit`/`offset`の不変条件チェックを共通ヘルパー（`src/lib/orders/list-options-validation.ts`想定）に集約し、4つの`list*`関数の先頭で呼ぶ（前提制約3参照）。`limit`は1〜100の整数以外、`offset`は0以上の整数以外でErrorを投げる。HTTPステータスへの変換は行わない（呼び出し元APIの責務）
- `.order()`は必ず`dateFrom`/`dateTo`の絞り込みに使っているカラムと同じキーを使うこと（`case_orders→case_datetime` / `loan_returns→return_datetime` / それ以外→`created_at`）。フィルタキーとソートキーがズレると、施設ごとの該当件数がlimitを超えた場合にDB側で誤ったキーで先に切り詰められ、SET-Dのunified-repositoryが前提とする「displayDatetime降順で上位N件」という不変条件が崩れる（型安全・データ層整合レビューで確認された実バグ）。同時刻の安定ページングのため`id`昇順を第2キーとして併用する
- テスト観点:
  - dateFrom/dateTo境界値テスト（UTC/JST変換を含む）
  - `.order()`のキーがdateFrom/dateToで絞り込むカラムと一致していること（case_orders→case_datetime、loan_returns→return_datetime）
  - productSearchが空の場合はフィルタを適用しない
  - limit上限: 最大100（100超はrepository層でError）、負数もrepository層でError（offsetの負数も同様）

#### SET-D: 横断APIエンドポイント新設 `/api/orders`
- ファイル: `src/app/api/orders/route.ts`
- 内部構造として`src/lib/orders/unified-repository.ts`を新設し、4種別の並列取得・マージ・summaryLabel解決・facilityName解決をここに集約する（API routeを薄く保ち、将来の種別追加を1箇所で完結させるため）
- GETパラメータ: `facility_id`, `date_from`, `date_to`, `product_search`, `order_kinds`（CSV）
- 実装方針:
  - `requireAuth`（未認証→401） → `requireFacilityAccess`（非adminはfacility_id必須、省略/不正→400、他施設→403）
  - `order_kinds`に`OrderKind`以外の未知の値が含まれる場合は400（前提制約・受け入れ条件参照）
  - `listFacilities(db)`を1回呼び、`id→name`のMapを作成する。admin時に`facility_id`未指定なら、このMapのキー（全施設ID）を対象施設IDリストとして使う（facilityNameの解決と対象施設ID列挙を同じ1回のクエリ結果で兼ねる。前提制約5参照）
  - `Promise.allSettled`で4種別を並列取得（各種別limit=20固定、v1ではoffset無し）。admin全施設対象時は種別ごとに対象施設分`list*`を並列呼び出しし、施設をまたいでdisplayDatetime降順にマージしてから上位20件に絞り込む（=1種別あたり最大「施設数×20件」を一時的に取得してから絞り込むため、施設数が多い環境ではクエリ数・レイテンシが線形に増える。既知の未対応・今後の課題を参照）
  - マージ後、日時降順・同時刻は`id`昇順で安定ソート
  - summaryLabelの解決はjan経路とconsumable_id経路を分けてバッチ化する（いずれもN+1回避のため個別クエリにしない。**SET-Cのproduct/consumable JOINとは別の、表示専用の名前解決クエリ**であり、取得済みレコードの代表1品目分のキーのみをバッチでIN句解決する）:
    - case_orders・loan_returnsから収集したjan（各注文の代表1明細分）をまとめて`products`へIN句1本
    - consumable_ordersから収集したconsumable_id（代表1明細分）をまとめて`consumables`へIN句1本
    - loan_ordersは`loan_order_items.name`を直接使うためJOIN/IN句不要
- レスポンス: `{ orders: UnifiedOrder[], errors: Array<{ kind: OrderKind; message: string }> }`
  - 失敗種別は`orders`に含めず、`errors`に理由を記録。`counts`フィールドは持たない
- バリデーション: `date_from`/`date_to`はISO 8601 UTC文字列として受け取り、API側での変換はしない
- テスト観点:
  - 非adminがfacility_id省略 → 400 / 他施設facility_id → 403 / 未認証 → 401
  - `order_kinds`に未知の値が含まれる → 400
  - 4種別すべて空 → `{ orders: [], errors: [] }`
  - 1種別が失敗しても他の結果は返すこと（`errors`に該当種別が入ること）
  - `src/lib/orders/unified-repository.ts`自体の単体テスト（route.test.tsでの`fetchUnifiedOrders`モック化とは別に必須）: displayDatetime降順・同時刻id昇順の安定ソート、summaryLabelの代表製品名+残n件表示、品目0件時の表示文言、facilityNameの解決、admin全施設ファンアウト時の種別ごと上位20件への絞り込み

#### SET-E: UIコンポーネント
- ファイル（新規）:
  - `src/components/orders/OrderHistoryFilters.tsx` — フィルタフォーム（期間・品名・種別・施設）。複数施設所属時は施設ドロップダウンを表示
  - `src/components/orders/OrderHistoryTable.tsx` — `UnifiedOrder[]`を受け取るテーブル。空状態・エラーバナー・スケルトンを含む
  - `src/components/orders/OrderKindBadge.tsx` — `OrderKind`を受け取り種別カラーバッジを返す
- テスト観点:
  - `OrderHistoryTable`: `orders=[]`で「該当する発注履歴がありません」表示、`errors`が空でなければ「一部の発注種別を取得できませんでした」バナー表示、`loading=true`時はスケルトンUIを表示し行を描画しないこと、`showFacilityColumn=false`時は施設名カラム自体を出さないこと（非adminには不要なため）
  - `OrderKindBadge`: 4種別（case/consumable/loan/loan_return）すべてで対応する日本語ラベル（症例発注/消耗品発注/貸出発注/貸出返却）が表示されること、未知の値を渡してもクラッシュしないこと
  - `OrderHistoryFilters`: 種別チェックボックスの初期状態は全選択、施設ドロップダウンは`showFacilitySelect=false`時に表示されないこと
  - アクセシビリティ: テーブル見出し（`<th>`）に`scope="col"`属性、`OrderKindBadge`のルート要素に`aria-label`（例: `症例発注`）

#### SET-F: `/orders`ページ実装
- ファイル: `src/app/orders/page.tsx`
- 実装方針:
  - `'use client'`、`useSearchParams()`でURLクエリを読み取り
  - `Suspense`で`OrdersPageContent`をラップし、`fallback`を必ず指定する
  - フィルタ変更 → `router.replace`でURL更新 → `useEffect`で再フェッチ
  - JST日付をUTCに変換してからAPIへ渡す変換ロジックはクライアントユーティリティに集約（選択日00:00:00+09:00 → UTC変換）
  - admin判定・施設一覧の取得は`GET /api/user-facilities`（前提制約6・実装セット一覧の補足参照）をfetchして行う。クライアントコンポーネントから`listUserFacilities`等のサーバー専用repository関数を直接importすることはできないため、既存`useUser`フックのみでは施設一覧を取得できない
  - facility_idの決定ロジック（APIの400/403ルールと対応させる）:
    - admin: 施設フィルタ未選択なら`facility_id`を付けずにリクエスト（API側でfacility_id=null許可）。選択時はその値を付ける
    - 非admin・所属施設1件: `/api/user-facilities`が返した唯一の施設を自動的に`facility_id`としてリクエストに付与（UI非表示）
    - 非admin・所属施設2件以上: 施設ドロップダウンで選択された値（初期値は先頭施設）を`facility_id`として必ず付与する。ドロップダウン未選択のまま初回リクエストを送らない（先頭施設をstateの初期値にしてから初回フェッチする）
    - 非admin・所属施設0件: ドロップダウンを表示せず「所属施設がありません」を表示し、`/api/orders`へのリクエストを送らない（受け入れ条件・フィルタ節参照）
- テスト観点:
  - 非adminでページが開けること（自施設facility_idが自動セットされること）
  - フィルタ変更でURLが更新されること
  - ローディング中にスケルトンUIが表示されること
  - 非adminで所属施設が0件の場合に「所属施設がありません」を表示し、無限ローディングにならないこと

### 並列グループ宣言

```
グループ1（並列）: SET-A + SET-B
  - SET-A 触るファイル: supabase/migrations/（新規1ファイル）
  - SET-B 触るファイル: src/types/order.ts

グループ2（グループ1完了後、並列）: SET-C + SET-E
  - SET-C 触るファイル:
      src/lib/case-orders/repository.ts
      src/lib/consumable-orders/repository.ts
      src/lib/loan-orders/repository.ts
      src/lib/loan-returns/repository.ts
  - SET-E 触るファイル:
      src/components/orders/OrderHistoryFilters.tsx（新規）
      src/components/orders/OrderHistoryTable.tsx（新規）
      src/components/orders/OrderKindBadge.tsx（新規）

グループ3（SET-C完了後、SET-B完了後）: SET-D
  - 触るファイル:
      src/app/api/orders/route.ts（新規）
      src/lib/orders/unified-repository.ts（新規）

グループ4（SET-D + SET-E完了後）: SET-F
  - 触るファイル: src/app/orders/page.tsx（新規）
```

### 既知の未対応・今後の課題

| 事項 | 理由 | 対応時期 |
|---|---|---|
| 未返却バッジ（案B: loan_order_id FK追加） | 停止①「判断が必要な点①」で確定待ち | 停止①後、別issue推奨 |
| 全体横断のcursor-basedページネーション | v1は固定80件表示で対応、それ以上はコスト超過 | 別issue |
| JAN単独フィルタ | 種別間で挙動が不統一（case/loan_returnはjan、consumableはjan NULL可） | 別issue |
| 既存4 API（case-orders等）のlimit/offsetのHTTPステータスコードへのバリデーション修正 | 本issueのスコープ外（repository層の不変条件チェックのみSET-Cで対応済み） | 別issue（pending_issues.jsonlで追跡） |
| モバイル表示 | v1はテーブル横スクロール（`overflow-x:auto`）で対応、カード切替は対象外 | 別issue |
| admin全施設対象時のファンアウトクエリ数（施設数×4種別分の`list*`呼び出し） | v1は施設数が少数（数十施設程度）である前提で許容。施設数が数百規模に増える場合はDB側での集約（マテリアライズドビュー等）かcursor-based全体ページネーションへの再設計が必要 | 施設数増加時に別issueで再検討 |

### 後任AIへの注意

- `/orders`は`/facilities/[id]/`配下ではなくトップレベルに置く
- `requireFacilityAccess`は非adminでfacility_id=nullを`FACILITY_ID_REQUIRED`として弾く。非adminユーザーの施設ID取得（サーバー側）には`user_facilities`テーブルを参照する既存関数（`listUserFacilities`等）を再利用すること。ただしクライアントコンポーネント（SET-F）からはこれらのサーバー専用repository関数を直接importできないため、`GET /api/user-facilities`（前提制約6）を経由すること
- v1では「未返却」判定を一切実装しない（`isUnreturned`フィールドも型に含めない）。案B採用が決まった場合のみ、API層（SET-D）に`loan_returns`へのLEFT JOINを1箇所追加する設計とする
- `/api/orders`レスポンスキーは`orders`（`returns`ではない）に統一する。`counts`フィールドは持たない
- ConsumableOrderの製品検索は`consumables`テーブルへのJOINが必要（janはconsumable_order_itemsにはない）。JAN検索自体はv1スコープ外
- `case_orders`・`loan_returns`の`list*`は`dateFrom`/`dateTo`のフィルタキー（`case_datetime`/`return_datetime`）と`.order()`のソートキーを必ず一致させること。ズレるとfetchTopN前提の「displayDatetime降順で上位N件」が崩れる（型安全・データ層整合レビューで実際に検出されたcriticalバグ。修正済みだが再発させないこと）
- `src/types/order.ts`の`OrdersQueryParams`型は現状どのファイルからも参照されていない未使用の型定義。型定義は契約（contract-writer確定分）のため本レビュー対応では削除していない。次に`src/types/order.ts`を触る機会があれば、契約管理者の判断で削除を検討すること

---

## Part 3 — セルフチェック

- 受け入れ条件の各項目は上記「実装計画」のいずれかのSETに対応している。ただし当初のSET-F計画には`GET /api/user-facilities`エンドポイントの記載が抜けており（クライアントコンポーネントからサーバー専用repository関数を直接呼べないというアーキテクチャ上の制約を見落としていたため）、統合時点で実装が追加された。前提制約6・実装セット一覧の補足に事後反映済み
- 「v1スコープでやらないこと」に列挙した3項目（未返却バッジ・追加ページネーション・JAN検索）は、いずれもPhase 1調査でコードレベルの矛盾・非対称性が確認された上での除外であり、対応する「既知の未対応」に将来対応の道筋を記載済み
- RLS/facility境界: 新規テーブル・新規RLSポリシーは追加しない（既存ポリシーを再利用）。API層の`requireFacilityAccess`呼び出しがdefense-in-depthとして機能する
- 中核集約ロジック（`src/lib/orders/unified-repository.ts`）は`route.test.ts`での`fetchUnifiedOrders`モック化とは別に、実装本体を直接検証する単体テスト（`src/lib/orders/__tests__/unified-repository.test.ts`）が存在すること
- `case_orders`・`loan_returns`の`list*`は、dateFrom/dateToで絞り込むカラムと`.order()`のソートキーが一致していること（型安全・データ層整合レビュー対応）
