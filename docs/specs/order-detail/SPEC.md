# 機能仕様書: 症例発注・短貸返却の詳細ページ（issue #809）

状態: **停止①通過（2026-09-20 承認）。** Part 1 の「人が決める値」5 項目は、すべて「私の推薦」列のとおりに確定した
（A=(2) 登録した全項目を出す / B=(1) viewer に見せる / C=(3) 施設ごとの一覧・ロット検索・`/orders` の 3 か所から開ける /
D=(1) ページ送りはやらない / E=(1) 正規の閲覧は記録しない。弾かれた試行は残す）。
人は仕様書を見たうえで承認した（deep の実行中に届いた「おすすめで進めて」は、仕様書を見せる前だったので承認として扱わなかった）。

調査: `aidd-1-1-deep-task`（run `wf_3b8262a1-d95`、2026-09-20、81 体）。Sweep 4 軸 × 3 ラウンド → ドラフト →
Find 52 件 → AV 検証 44 件中 19 件生存 → 3 案の採点 → 統合。
**下の「調査から分かったこと」は、deep の出力をそのまま写さず、1 文ずつ実ファイルを開いて確かめたものだけを書いた**
（issue #803 で、確かめていない判断材料を人に出して決定を取り直した反省）。deep の推薦と違う推薦をした箇所は理由を書いてある。

---

## Part 1 — 仕様（人間レビュー用）

### 1. 何ができるようになるか

登録した症例発注・短貸返却を **1 件開いて、登録した中身をあとから確認できる**。
対象はこの 2 種別だけ（人が 2026-09-20 に決めた。短貸発注・消耗品発注は対象外）。読み取り専用で、既存の作成・更新・取り消しの挙動は変えない。

いまの状態（実物で確認）:

| 画面 | 件数 | 行に出るもの | 明細 | 患者の情報 |
| --- | --- | --- | --- | --- |
| `/orders`（横断の履歴） | ページ送り・種別・期間・キーワードあり | 種別・状態・概要・作成日 | 出ない | 出ない |
| `/facilities/[id]/case-orders` | 最新 50 件のみ | 症例日時・**手技名**・状態・作成日 | **出ない** | **出ない** |
| `/facilities/[id]/loan-returns` | 最新 50 件のみ | 返却日時・状態・作成日 | JAN・数量・取り消しの状態（**ロット・使用期限は出ない**） | （持たない） |

患者 ID・イニシャル・性別・医師名、明細のロット・使用期限が画面に出るのは**新規登録の入力フォームだけ**。
`GET /api/case-orders` は全部返している（`src/lib/case-orders/repository.ts:92-105`）が、画面が出していない。

### 2. 人が決める値（5 項目。**まだ何も決まっていない**）

| # | 決めること | 選択肢 | 調査から分かったこと（実ファイルで確認済み） | 私の推薦 |
| --- | --- | --- | --- | --- |
| A | 症例発注の詳細に出す患者の情報 | (1) 患者 ID・イニシャルだけ / (2) 登録した全項目（患者 ID・イニシャル・性別・医師名・手技名） | **手技名は一覧ページが既に出している**（`case-orders/page.tsx:74,85`）。施設のメンバー（viewer を含む）は `GET /api/case-orders` で全項目を既に受け取れる。deep は「P-062・P-067 から逸脱する」として (1) を推薦したが、**P-062・P-067 は監査ログの約束**（`promise-catalog.md:91,96`。`audit_log` の施設境界と、`/admin/audit` に行の中身を出さないこと）で、発注の画面の約束ではない | **(2)**。この画面の目的は「登録した中身の確認」で、登録した項目を隠すと目的を果たせない。見える人も増えない。ただし「画面に出す情報は最小限にしたい」という運用上の考えがあれば (1) |
| B | 閲覧のみのロール（viewer）に見せるか | (1) 見せる / (2) 見せない | 既存の読み取り API（一覧）はロールで分けていない（`case-orders/route.ts:13-35` に role の分岐なし）。viewer は一覧 API で同じ情報を既に受け取れる | **(1)**。新しく見える物が無い。ロールで出し分けるロジックを足すと、測る対象が増える |
| C | どこから開けるようにするか | (1) 施設ごとの一覧だけ / (2) 施設ごとの一覧 + ロット検索 / (3) その 2 つ + `/orders` | 施設ごとの一覧は**最新 50 件だけ**でページ送りが無い。`/orders` にはページ送りと絞り込みが既にあり、行は `id`・`kind`・`facilityId` を持つ（`OrderHistoryTable.tsx`）ので、リンクに要る情報は揃っている。ロット検索の行は `parentId` を持つ。deep は (1) を推薦したが、**(1) だと最新 50 件より古い記録の詳細を開く道が無い**＝この issue を立てた理由（ロット検索から古い記録へ辿れない）が解決しない | **(3)**。古い記録へ辿る道は `/orders` とロット検索にしか無い。リンクを足すだけで、新しい画面は増えない |
| D | 施設ごとの一覧のページ送りを同時にやるか | (1) やらない / (2) やる | 一覧 API は `limit`・`offset` を既に受ける。C を (3) にすれば、古い記録へは `/orders` から辿れる | **(1)**。C=(3) で目的は果たせる。別 issue |
| E | 開いたこと自体を記録するか | (1) しない / (2) する | `audit_log` の `action` は `INSERT`・`UPDATE`・`DELETE` だけ（`20260906000004_add_audit_log.sql:27` の CHECK）。読み取りを残すには表か列の追加が要る。**他施設の ID を直指定して弾かれた試行**は、既存の仕組み（`recordHiddenRowDenial` → `access_denials`）で残せる | **(1)**。正規の閲覧の記録は全画面に関わる話なので別 issue。**弾かれた試行は残す**（下の受け入れ条件） |

### 3. 操作の流れ

1. `/orders` の行、施設ごとの一覧の行、ロット検索の行のどれかから、その 1 件を開く（決定 C）
2. 詳細ページ（`/facilities/[id]/case-orders/[orderId]`・`/facilities/[id]/loan-returns/[returnId]`）に、登録した中身が出る
   - 症例発注: 症例日時・状態・患者の情報（決定 A）・明細（JAN・ロット・使用期限・数量・単価）
   - 短貸返却: 返却日時・状態・元の短貸発注への紐づき（あれば）・明細（JAN・ロット・使用期限・数量・取り消しの状態）
3. 取り消し済みは**消さずに文字で示す**（返却の回ごと・明細ごとの両方。色だけにしない）。
   取り消しは「その記録は誤りだった」の意味で、明細が取り消し済みなら「実際には返却されていない可能性があります」を添える（ロット検索と同じ文言）
4. 見つからないとき（存在しない・他施設・形式が不正な ID）は、どれも同じ「見つかりません」と「一覧へ戻る」を出す。
   技術的なエラー文（`invalid input syntax for type uuid` など）は画面に出さない
5. 読み込み中・通信の失敗・サーバーの失敗は、既存の画面と同じ形の表示にする（新しいエラーの体系は作らない）

### 4. 受け入れ条件

**API**
- [ ] `GET /api/case-orders/[id]`・`GET /api/loan-returns/[id]` が 1 件（ヘッダ + 明細）を返す。既存の PATCH の挙動は変えない
- [ ] 認可は既存の `hospital-prices/[id]` の GET と同じ「先引き → 施設判定」（`src/app/api/hospital-prices/[id]/route.ts:18-36`）:
      ID だけで引く → RLS で見えなければ **404**（存在の有無を漏らさない）→ 見えたら、その記録の `facility_id` で `requireFacilityAccess`。
      **施設 ID をクライアントの入力から取らない**
- [ ] 存在しない ID・他施設の ID・形式が不正な ID は、どれも 404 か 400 で、**500 にならない**。応答に患者の情報も、その記録が存在するかどうかも含まれない
- [ ] RLS で見えなかった試行は `recordHiddenRowDenial` で `access_denials` に残る（`HiddenRowTable` に `case_orders`・`loan_returns` を足す）。記録の失敗は応答を変えない
- [ ] エラー応答とサーバーログに患者の情報を出さない（`repositoryError`・`log-safe.ts` を通す。repository が投げたエラーの本文に患者の情報が入っていても応答に出ないことをテストする）
- [ ] 新しい 2 つの route × GET が `e2e/api-attack-matrix.ts`（P-017）に載っている

**施設の境界（issue #803 で抜けていた観点）**
- [ ] **他施設の一般メンバー**が ID を直指定しても取れない（RLS の層）。admin のケースだけでは RLS を測れない（admin は RLS を全施設ぶん通る）ので、
      fixture に他施設の一般メンバーを置いて実 DB で測る。対照: 自施設のメンバーなら取れる
- [ ] **URL の施設 ID と、記録の施設 ID が食い違うとき**（複数の施設に所属する人が `/facilities/A/...` の下に施設 B の記録の ID を入れた場合）、
      詳細ページは「見つかりません」を出す。施設 A の画面の下に施設 B の記録を出さない
- [ ] aal1（MFA 未昇格）のセッションが API に届かないこと。`src/__tests__/proxy.test.ts` の matcher のテストに、
      **動的な区切りを含む実際の形のパス**（`/api/case-orders/<uuid>`）を足す。aal1 が repository まで届くと RLS が空を返し、
      404 と区別がつかなくなる（ロット検索と同じ危険）

**画面**
- [ ] 詳細ページが 2 つあり、決定 A の範囲の情報と明細（ロット・使用期限を含む）が出る
- [ ] 取り消し済みが文字で分かる（回ごと・明細ごと）。`case-orders/page.tsx` の `STATUS_LABEL` に `cancelled` を足す
      （**既存のバグ**: 型には `cancelled` があるのにラベルが無く、一覧に英字のまま `cancelled` と出る。`src/types/order.ts:11` と `page.tsx:8-11`）
- [ ] 決定 C の入口から開ける。ロット検索は、issue #803 でやめた行ごとのリンクを**詳細ページ宛てで**復活させる（`parentId` を使う。`#` つきのリンクにしない）
- [ ] 見つからない・読み込み中・通信の失敗のそれぞれの表示がある。200 だが JSON でない応答（proxy のリダイレクト先の HTML）を「見つかりません」と出さない
- [ ] キーボードだけで一覧から詳細、詳細から一覧へ戻れる

**壊していないこと**
- [ ] 既存の作成・更新・取り消しのテストが全部通る
- [ ] PR の前に `scripts/*.test.sh` を**止めずに全件**回す／`bash scripts/build-plugin.sh` で生成物に差分が出ないことを見る／
      lint の無効化コメントを足さない／上限の数字を直書きしない（issue #803 で CI を落とした 3 件）

### 5. 今回やらないこと

- 短貸発注・消耗品発注の詳細（人が対象外と決めた）
- 施設ごとの一覧のページ送り（決定 D）、正規の閲覧の記録（決定 E）
- ロット検索の一覧に品名を出す／CSV 出力・印刷（issue #809 本文の未決の 2 点。別に決める）
- admin が施設を指定せずに全施設の発注を横断して開く機能

### 6. 作業中に見つけた別件（この issue では直さない）

- **1 件の発注に登録できる明細の件数に上限が無い**（`schemas.ts:188,223` は `z.array(...).default([])`）。
  量の上限は `docs/agents/design-questions.md` の「人に聞いて決める値」の 1 つで、決めた記録が無い。
  詳細ページは**明細を切らずに全部出す**（切ると、リコールで引いた明細がその発注のどこかに埋もれる）ので、上限は登録の側で決めるのが筋
- deep は「既存の `PATCH /api/loan-returns/[id]` は本文の `facilityId` を信用していて E-014 と同じ型の危険がある」と指摘し、
  同じ deep の 3 ラウンド目が「repository が `id` と `facility_id` の両方で絞っているので成立しない」と反証した。**私は確かめていない**

---

## Part 2 — 実装計画（AI 用）

### 認可の形（1 つに決める）

deep のドラフトは repository を `getCaseOrder(db, id, facilityId)`（施設 ID を先に知っている前提）、route を「先引き → 施設判定」（施設 ID を後で知る）と
**両立しない 2 つ**で書いていた（deep 自身の指摘）。**先引きに統一する**:

```
getCaseOrder(db, id): Promise<CaseOrder | null>      // 施設 ID を引数に取らない
getLoanReturn(db, id): Promise<LoanReturn | null>
```

- 見つからない（存在しない・RLS で見えない）→ `null`。技術的な失敗 → 例外。**この 2 つだけ**
- 形式が不正な ID は、DB へ投げる前に route で弾く（既存の `UUID_PATTERN`、`src/lib/validation/uuid.ts`）。
  PostgREST の uuid 変換エラーを 500 にしない。応答は 404（形式の正否も漏らさない）
- route: `requireAuth` → ID の形式 → `get*` → `null` なら `recordHiddenRowDenial` して 404 → `requireFacilityAccess(db, user, record.facilityId)` → 失敗なら 403 ではなく **404**
  （`hospital-prices/[id]` は 403 を返すが、ここに来るのは「RLS では見えたが `requireFacilityAccess` で落ちた」場合だけで、
  admin でも一般メンバーでも通常は起きない。起きたら存在を漏らさない側に倒す）
- admin は RLS を全施設ぶん通り、`requireFacilityAccess` も施設 ID があれば通るので、admin は ID を知っていればどの施設の記録も開ける。
  これは admin が施設を切り替えて一覧を見られる既存の権限と同じ範囲。**ただし詳細ページは URL の施設 ID と記録の施設 ID の一致を見る**（受け入れ条件）

### セット（依存順）

**セット A — 型と repository**
- `src/types/order.ts`: 戻り値は既存の `CaseOrder`・`LoanReturn`（ヘッダ + `items`）をそのまま使う。新しい型を増やさない
- `src/lib/case-orders/repository.ts`・`src/lib/loan-returns/repository.ts`: `get*` を足す。行 → 型の写しは**一覧と同じ関数を使う**
  （一覧の `map` の中身を関数に切り出して共有する。同じ写しを 2 か所に書かない）
- `src/lib/security/hidden-row-denial.ts`: `HiddenRowTable` と `lookupFacilityId` に 2 つの表を足す
- テスト: 見つかる／見つからない→`null`／DB エラー→例外／明細が 0 件／取り消し済みの明細を落とさない

**セット B — route**（A の後）
- `src/app/api/case-orders/[id]/route.ts`・`src/app/api/loan-returns/[id]/route.ts` に GET を足す（PATCH は触らない）
- `e2e/api-attack-matrix.ts` に 2 行
- `src/__tests__/proxy.test.ts`: matcher のテストに `/api/case-orders/<uuid>`・`/api/loan-returns/<uuid>` を足す
- テスト: 401／形式不正 404／見つからない 404 + 拒否の記録／正常系／エラー本文の患者情報が応答に出ない

**セット C — 画面**（B の後）
- `src/app/facilities/[id]/case-orders/[orderId]/page.tsx`・`src/app/facilities/[id]/loan-returns/[returnId]/page.tsx`（新規）
- `case-orders/page.tsx`: `STATUS_LABEL` に `cancelled`、行から詳細へのリンク。`loan-returns/page.tsx`: 行から詳細へのリンク（既存の取り消しボタンは触らない）
- `OrderHistoryTable.tsx`: 種別が症例発注・短貸返却の行に詳細へのリンク（`item.facilityId` を使う。他の 2 種別には出さない）
- `lot-search/page.tsx`: 行ごとのリンクを詳細ページ宛てで足す（種別ごとの一覧へのリンクと断り書きは、詳細から戻れるので外してよい）

**セット D — 実 DB と E2E**（B の後。C と並行可）
- `supabase/__tests__/integration/order-detail-rls-idor.integration.test.ts`: 自施設のメンバー（対照）／**他施設の一般メンバー**／admin／aal1 の DB 層での姿。
  `describe` 名に `[P-013 P-015]` を入れる
- `e2e/order-detail.spec.ts`: 一覧 → 詳細 → 戻る／`/orders` から開く／ロット検索から開く／**51 件目より古い記録を `/orders` とロット検索から開ける**
  （issue #803 の E2E は作ったばかりの記録でしか測っておらず、古い記録に届かないことを見逃した）
- `docs/agents/promise-catalog.md`: P-013・P-015 の適用範囲に入ることを注記。新しい約束は作らない見込み

### 並列グループ
- 波 1: セット A ／ 波 2: セット B ／ 波 3: セット C と セット D

---

## deep の出力からの訂正（裏を取って直したもの）

1. **決定 A の根拠「P-062・P-067 から逸脱する」は当てはめ違い。** どちらも監査ログの約束で、発注の画面の約束ではない。
   しかも一覧ページは手技名を既に出している。推薦を (1) から (2) に変えた
2. **決定 C の推薦「施設ごとの一覧だけ」だと、この issue の目的が果たせない。** 施設ごとの一覧は最新 50 件だけで、
   古い記録の詳細を開く道が無くなる。推薦を (3) に変えた
3. repository と route で**両立しない 2 つの認可の形**が書かれていた（deep の Completeness Critic が指摘）。先引きに統一した
4. 「形式が不正な ID は repository のエラーを `ClientVisibleError` に変換して 400」は、その変換が本当に起きるかを誰も確かめていなかった
   （AV を生き残った指摘）。DB へ投げる前に route で形式を見る形にして、確かめる必要そのものを無くした
5. 実物で確認した主張: `hospital-prices/[id]` の GET は先引き → 404 + 拒否の記録 → `requireFacilityAccess`／
   `HiddenRowTable` は `'facilities' | 'hospital_prices'` のみ／`CaseOrder.status` に `cancelled` があり一覧の `STATUS_LABEL` に無い／
   `OrderListItem` は `id`・`kind`・`facilityId` を持つ
