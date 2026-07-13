# 2026-07-08 hospital-prices-facility-selector

## フロー実行時間
- Phase 1（調査）:    —
- Phase 2〜5（実装）: 1分12秒
- AI稼働合計:         1分12秒
- セッション総時間:   —（人間レビュー待ち含む）

## フロー実行統計

### Phase 1 調査
- Sweeper: 4台 × 1ラウンド
- 指摘あり軸数: 3 / 4

### Phase 2〜5 実装・検証
- implementer: 1台（並列）
- integrator: 1台
- reviewer: 0台（並列）
- 合計エージェント: 1台
- 実装成功: 1 / 1グループ

## 結果
- うまくいったこと:
- 問題・気になった点:
- 次の課題:

## アーカイブ: 実装時のSPEC.md本文

実装完了・PR #31マージ済みのため、当時SPEC.mdに置かれていた仕様書本文をここに保存する
（SPEC.mdは「現在作業中の仕様書」を置く単一ファイル運用のため、後続タスクの仕様書に
置き換わる際に本文が失われないよう記録）。

---

# SPEC: /hospital-prices に施設セレクタUIを追加（Issue #29）

---

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

- 複数の施設に所属しているユーザー、および管理者(admin)が、「施設別価格管理」画面(`/hospital-prices`)で見たい施設を切り替えられるようになります。
- これまでは常に「先頭の施設」の価格しか表示されませんでしたが、画面上部に施設を選ぶプルダウンが追加され、選んだ施設の価格一覧に切り替わります。
- 管理者も含めて、必ずどれか1つの施設を選んだ状態で価格一覧を見る、という単純な仕組みに統一します（「全施設まとめて表示」という特別モードは今回は作りません。将来的に必要になれば別issueで検討します）。**[人間承認済み: 施設選択必須のみ]**
- 施設を切り替えた状態はURLに記録されるため、リロードしたり、URLをブックマーク・共有したりしても選択していた施設が保持されます。**[人間承認済み: URLクエリパラメータで保持]**

### 画面イメージ / 操作の流れ

1. `/hospital-prices` を開く（例: `/hospital-prices?facilityId=<施設名昇順の先頭施設ID>`）
2. 画面上部（見出し「施設別価格管理」の下）に施設選択プルダウンが表示される 📸
3. 初期状態では、URLに`facilityId`が無ければ自分が所属する施設のうち施設名の昇順で一番先頭の施設が選ばれており、その施設の価格一覧が表示されている（`listFacilities()`は`name`昇順ソートのため順序は安定している）
4. プルダウンから別の施設を選ぶと、その施設の価格一覧に切り替わり、URLの`facilityId`クエリパラメータも更新される 📸
5. その状態でリロード、または他ページから戻ってくると、URLの`facilityId`で指定した施設が選択されたまま表示される
6. 1施設にしか所属していないユーザーの場合、プルダウンは1件だけの選択肢になる（切り替え自体は可能）

### 受け入れ条件（チェックリスト）

- [x] `/hospital-prices` 画面上部に施設選択プルダウンが表示される
- [x] 初期表示時、URLに`facilityId`クエリパラメータが無ければ、自分が所属する施設一覧を施設名の昇順で並べた先頭施設が選択され、その施設の価格が表示される（既存動作を維持）
- [x] URLに`facilityId`クエリパラメータがある場合は、それに対応する施設が初期選択される（自分がアクセス権を持つ施設に限る。不正・アクセス不可なfacilityIdの場合は先頭施設にフォールバックする）
- [x] プルダウンで別の施設を選ぶと、選択した施設の価格一覧に切り替わり（`/api/hospital-prices?facilityId=...` を選択施設IDで再取得）、URLの`facilityId`クエリパラメータも更新される
- [x] admin（全施設が選択肢に並ぶ）も同じプルダウンUIで施設を切り替えられる。「全件表示」オプションは設けない
- [x] 所属施設が0件の場合、プルダウンは空表示となり、価格一覧も空のまま（エラーにはしない。既存の「先頭施設なし→空配列」の挙動を踏襲）
- [x] 既存の新規登録・編集・削除の導線（各行のボタン、`+ 新規価格を登録`）は施設切り替え後も同様に動作する
- [x] `requireFacilityAccess` / RLS（`facility_member_or_admin`）による施設ごとのアクセス制御は変更しない（プルダウンの選択肢は `/api/facilities` が返す＝アクセス可能な施設のみになる）

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 実装セット一覧（依存順）

**Set A: 施設セレクタ状態管理とURL連動・データ取得の分離**
- `src/app/hospital-prices/page.tsx` を改修
  - 現状: 1つの `useEffect` で facilities・prices（先頭施設固定）・distributorProducts をまとめて取得
  - 変更後:
    - `useSearchParams()`（next/navigation）でURLの `facilityId` クエリパラメータを読む
    - 初回ロード用 `useEffect`（`refreshKey` 依存）: facilities・distributorProducts を取得。取得後、選択施設IDを次の優先順で決定する
      1. URLの `facilityId` が取得済み facilities に含まれていればそれを採用
      2. 含まれていない（未指定・不正・アクセス不可）場合は施設名昇順の先頭施設を採用
      3. facilities が空なら `null`
      決定した施設IDが現在のURLの`facilityId`と異なる場合は `router.replace()` でURLを同期する（履歴を汚さないため push ではなく replace）
    - `selectedFacilityId` state はURLの `facilityId` を信頼できる情報源(source of truth)とし、上記で決定した値で初期化・更新する
    - 施設セレクタの `onChange` では `router.replace(`/hospital-prices?facilityId=${newId}`)` のように URLを更新する。URL変更 → `useSearchParams()` の再評価 → `selectedFacilityId` 反映という流れにする
    - 価格取得用 `useEffect`（`selectedFacilityId` 依存）: `selectedFacilityId` が truthy なら `/api/hospital-prices?facilityId=...` を取得、falsy（施設0件）なら `prices` を空配列にする
  - `<select>` 要素を見出し行の下に追加。`value={selectedFacilityId ?? ''}`
  - 削除後の `refresh()` は現在の `selectedFacilityId` を維持したまま価格のみ再取得されればよい（`refreshKey` は初回ロード用 useEffect のみに紐付け、価格再取得用 useEffect の依存に `refreshKey` は含めない。削除操作は同一施設内の話なので、削除後の再取得は価格取得用 useEffect の依存に `refreshKey` も追加して対応する）

**Set B: テスト追加**
- `src/app/hospital-prices/__tests__/page.test.tsx` に以下を追加
  - 複数施設が返る場合、プルダウンに全施設が選択肢として表示されること
  - URLに`facilityId`が無い場合、施設名昇順の先頭施設が初期選択されること
  - URLに有効な`facilityId`がある場合、その施設が初期選択されること
  - URLに不正・アクセス不可な`facilityId`がある場合、先頭施設にフォールバックすること
  - プルダウンで施設を切り替えると `/api/hospital-prices?facilityId=<選択したID>` が呼ばれ、表示される価格一覧が切り替わること、かつURLの`facilityId`が更新されること（`useRouter`のモックで`replace`呼び出しを検証）
  - 施設が0件の場合、プルダウンが空・価格一覧も空で表示されること（エラーにならない）

### 並列グループ宣言

- Set A（`src/app/hospital-prices/page.tsx`）と Set B（`src/app/hospital-prices/__tests__/page.test.tsx`）は別ファイルだが、Bのテストは Aの実装（stateの持ち方・selectのDOM構造）に依存するため、同一の波では実装せず **Set A → Set B の順で直列実装**する（TDDなので実際は「Bのテストを先に書いて赤にし、Aを実装して緑にする」進め方でも良い。ファイルは別だが内容的に密結合なため統合ゲート不要・1セット扱いとする）

### テスト観点

- 初期表示（URLパラメータなし）: facilities配列を名前昇順で並べた先頭が選択され、対応するfacilityIdでprices取得APIが呼ばれる
- 初期表示（URLパラメータあり・有効）: URLのfacilityIdが選択され、それでprices取得APIが呼ばれる
- 初期表示（URLパラメータあり・不正/アクセス不可）: 先頭施設にフォールバックし、URLも先頭施設のfacilityIdに補正される
- 切り替え: select の onChange 発火で正しいfacilityIdを指定して再フェッチされ、URLの`facilityId`も更新される（`router.replace`が呼ばれる）
- 空施設: facilities が空配列のとき、fetchが `facilityId` なしで呼ばれない（またはスキップされる）こと、エラー表示にならないこと
- 既存の削除・編集導線が回帰しないこと（既存テストのまま通ること）

### 型・データアクセス層の方針

- API層（`src/app/api/hospital-prices/route.ts`）・データアクセス層（`src/lib/hospital-prices/repository.ts`）・RLSは変更しない（Phase1調査で確認済み: `facilityId` によるクエリ絞り込みは既に実装済み）
- `Facility` 型（`src/types/facility.ts`）も変更なし。既存の `facilities` state をそのままプルダウンの選択肢に使う

### 実装上の注意

- `useSearchParams()` を使うクライアントコンポーネントはNext.jsの推奨に従い `<Suspense>` で囲む（Phase1調査で `src/app/login/page.tsx:111` に同種の指摘があった＝Suspense fallback未設定のパターンを繰り返さないこと）
