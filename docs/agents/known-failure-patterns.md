# 既知の失敗パターン・チェックリスト

過去に実際に発生した実装ミスを、次に同じコードパターンを書く/レビューする際に
**機械的にチェックする項目**としてここに蓄積する。

`decisions.md` との違い: あちらは「なぜその設計にしたか」という理由の記録。
ここは「このコードを見たら必ずこの項目を確認する」というチェックリストであり、
理由の深掘りはしない（理由が必要ならリンク先の decisions.md エントリを参照する）。

SPEC.md やコードコメントに書くだけでは実装フェーズで見落とされて再発する
（実例: 下記「Suspenseフォールバック」参照）ため、レビュー・Sweepフェーズで
機械的に拾えるようここに置く。

## UI層

### Suspenseフォールバック未設定（useSearchParams使用時）

**チェック内容:** `useSearchParams()` を使うクライアントコンポーネントが、
`<Suspense fallback={...}>` でラップされずにexportされていないか確認する。

**なぜ再発したか:** SPEC.mdに「Suspenseでラップする」と明記されていたにもかかわらず、
実装フェーズで見落とされブランクスクリーン（SSRハイドレーション時の一瞬の白画面）が
発生した実例がある。仕様書に書くだけでは防げないことが実証済みなので、レビュー時に
必ず該当パターン（`useSearchParams`/`usePathname`等の動的APIをトップレベルで呼ぶ
クライアントコンポーネント）を検索し、Suspense境界の有無を確認する。

## データ取得層 / API層

### SECURITY DEFINER + GRANT EXECUTEの認可バイパス

**チェック内容:** 新規・変更されたPostgreSQL RPC関数（`supabase/migrations/*.sql`）が
`SECURITY DEFINER` を付けている場合、必ず以下を確認する：
1. 関数内で `is_facility_member(...) OR is_admin()` 等の明示的な認可チェックを行っているか
2. GRANT EXECUTE の対象ロールが必要最小限か（機微データを返す関数に `anon` を含めていないか）

`SECURITY DEFINER` 関数はRLSをバイパスし、`/rest/v1/rpc/<function>` として
Next.js API Route（`requireFacilityAccess`等）を経由せず直接呼び出せる。
関数の引数（`p_facility_id`等）によるWHERE句の絞り込みは単なるフィルタであり、
「呼び出しユーザーがその施設に所属しているか」を検証する認可チェックではない。

**推奨:** まず「`SECURITY DEFINER` を付けずに済ませられないか」を検討する。
既存テーブルのRLSポリシーが正しく設定されていれば、`SECURITY INVOKER`
（デフォルト）のままでRLSが関数内クエリにも自動適用され、関数内に認可ロジックを
手書きする必要自体がなくなる。同種の既存関数（同じテーブルを横断取得するもの）が
コードベースに既にないか先に探す。

詳細: [`decisions/db-rls.md`](./decisions/db-rls.md#なぜ施設分離をrls--is_facility_member関数で実現したか)

### 後付けFK列のカーディナリティを宣言しないまま放置する（issue #675）

**チェック内容:** 既存テーブルへ `ALTER TABLE ... ADD COLUMN ... REFERENCES` で
関係を後付けしたら、その場で「**1対1か1対多か**」を宣言する。
1対1なら同じPRで UNIQUE 制約/部分UNIQUEインデックスを追加し、1対多なら SQL に
`-- cardinality: many <理由>` と書く。

**実際に起きたこと:** 2026-07-14 の `20260714000005_orders_history_prereqs.sql` が
`loan_returns` へ `loan_order_id UUID REFERENCES loan_orders(id)` を追加したが、
「loan_order 1件に返却は1件まで」というカーディナリティを誰も宣言しなかった。
宣言されなかったので仕様書にも書かれず、テストにも現れず、レビューでも問われず、
**84コミット・CI 1400本超を6週間通過し続けた**（2026-08-28 の issue #675 で発覚）。

**なぜテストで気づけなかったか:** 当該RPCの migration テスト
（`add_loan_order_id_to_loan_return_atomic_rpc.test.ts`）は
`expect(sql).toContain('insert into loan_returns (facility_id, return_datetime, loan_order_id)')`
という**実装で書いたSQL文字列を同じ文字列で照合する静的検証**だった。
実装の鏡になっているため、書き忘れたものは原理的に検出できない。
また `loan_returns` の統合テスト4本はすべて「**誰が**アクセスできるか」（RLS/IDOR）で、
「**何件まで**許すか」の軸が1つも無かった。

**教訓:** Assert は「あるべきものがある」だけでなく「**あってはならないものが無い**」を書く。
DB制約は「破ろうとしたら拒否される」ことでしか検証できず、静的SQL検証では原理的に確かめられない。

**機械検知:** `supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts`
（`npm test` に含まれる）が、①カーディナリティ未宣言の後付けFK列、②制約を導入したのに
そのテーブルが実DB統合テストに一度も登場しない migration、の2つを ratchet 方式で止める
（既知の未対応分は `constraint-coverage-baseline.json` に固定し、新規発生のみを失敗させる）。
判定ロジックは `.claude/workflows/lib/constraint-coverage.js`。

`scripts/check-constraint-coverage.sh` は現存する穴を**怪しい順**に表示する。怪しさは
機械判定（人の申告に依存しない）で、材料は「アプリのコード(`src/`)がそのテーブルを実際に
読み書きしているか（＝業務データか裏方か）」「`facility_id` を持つか（＝施設境界に関わるか）」
「制約の個数（＝書き忘れの余地の大きさ）」の3つ。判定結果は
`constraint-coverage-baseline.json` にも書き写され、機械判定とズレるとratchetテストが落ちる
（負債リストが「書いたきり陳腐化する」ことを防ぐ）。

同じ検知の型を**認可の側にも適用**している（`findRlsTablesWithoutIdorTest`）。
「RLSポリシーを書いた」＝「他人から守られている」ではなく、守られていることは
**他人（別施設のユーザー）のIDで実際に叩いて弾かれる**ことでしか確かめられない。
`CREATE POLICY` を持つのに `*-rls-idor.integration.test.ts` に一度も登場しないテーブルを
同じく怪しい順に出し、新規発生をratchetで止める（下記「issue #24再発防止」と対になる機構）。

**リストの読み方（重要）**: このリストは「**ここは確かめていない**」と言っているだけで、
「**ここ以外は確かめてある**」とは言っていない。障害時に「載っているからまず疑う」に使うのは
正しいが、「載っていないから違う」に使うと調査が遅れる。カバレッジ%と同じ誤読に注意する。

### 新しい認可プリミティブ導入時、既存のSECURITY DEFINER関数が取り残される（issue #458）

**チェック内容:** `is_admin()`のような新しい認可プリミティブを導入し、既存のRLSポリシーを
一斉更新する変更（`CREATE POLICY`の書き換え等）を行う場合、**同じタイミングで既存の
SECURITY DEFINER関数（手書きWHERE句で認可を実装しているもの）も棚卸しの対象に含める**。

**なぜ再発したか:** `get_distributor_product_price_history` RPCは`is_admin()`導入前に
書かれており、`is_facility_member(...)`のみで認可していた。翌日`is_admin()`が導入され、
全RLSポリシーに`OR is_admin()`が一斉追加されたが、このRPCは**RLSポリシーではなく
SECURITY DEFINER関数内の手書きWHERE句**だったため、その一斉更新の対象から漏れた。
RLSポリシーの棚卸し（`pg_policies`を見る、または`CREATE POLICY`をgrepする）では
この種の関数は見つからない。「RLSポリシー」と「SECURITY DEFINER関数内の認可ロジック」は
別物であり、片方だけを更新して安心してはいけない。

**推奨:** 新しい認可プリミティブを追加する変更では、RLSポリシーの一斉更新と合わせて
`grep -rl "SECURITY DEFINER" supabase/migrations/*.sql`で全SECURITY DEFINER関数を洗い出し、
その認可プリミティブ導入前に書かれたものが同様の認可チェックを持っているか確認する。

詳細: [`docs/specs/issue-458-459-price-history-admin-and-unit-price.md`](../specs/issue-458-459-price-history-admin-and-unit-price.md)（横断確認の実施結果を含む）

### クエリパラメータのバリデーション漏れ（NaN・負数・上限）

**チェック内容:** APIルートで `Number(request.nextUrl.searchParams.get(...))` のように
クエリパラメータを数値変換している箇所を見つけたら、以下を確認する：
1. `Number.isFinite()` チェックがあるか（`NaN`/`Infinity` を弾けるか）
2. 負数を弾いているか
3. `limit` 系パラメータに上限（最大値）があるか（上限なしは大量データ取得によるDoSベクタになる）

`Number('abc')` は静かに `NaN` を生成し、バリデーションなしで下流のクエリ・RPC呼び出しに
渡ると不可解な500エラーや想定外の挙動になる。素の `Number(...)` 変換を見たら、
上記3点を満たすガード節があるか必ず確認する。

## エージェント/hook運用層

### hookから`claude -p`を起動する際のsettings.json/hooks継承漏れ

**チェック内容:** Stop/PreToolUse等のhookスクリプトが検証・裏取り目的で`claude -p`
サブプロセスを起動している箇所を見つけたら、`--setting-sources ""`(または`--bare`)と
`--no-session-persistence`が付いているか確認する。

**なぜ再発したか:** これが無いと、サブプロセス自身のStopイベントで元のhook一式(サブプロセスを
起動したhook自身やグローバルの通知hook等)が継承・再発火し、子プロセスが際限なく増殖する。
2026-07-14に初回発生(15分で343セッション生成)、修正コミットがPR化されずmainに未マージだった
ため2026-07-15に別worktreeで再発した。詳細: [`2026-07-14-verification-subagent-design.md`の
「運用インシデント」節](../superpowers/specs/2026-07-14-verification-subagent-design.md#運用インシデントpostmortem)。

### findコマンドにクォートなしのglobを渡している

**チェック内容:** `find <path>* -maxdepth N` のように、`find` の引数にクォートしていない
globパターン（`*`等を含むパス）を渡していないか確認する。`find <path> -name '<pattern>*'`
のように `-name` オプションで絞り込むか、globをクォートしてシェル展開させない形に書き換える。

**なぜ再発したか:** クォートなしのglob（例: `find src/lib/mapping* -maxdepth 1`）は `find` が
実行される前にシェルが展開してしまう。カレントディレクトリに `-` で始まる名前のファイルが
存在すると、それが `find` のオプションとして誤解釈されうる構造的リスクがあるため、Claude Codeの
組み込み安全性チェックが「引用符なしglob」として毎回確認を要求する。これは`.claude/settings.json`
の`allow`リストへの追加では回避できない（コマンドの書き方自体を変える必要がある）。

### ワークフロースクリプトをnameで起動すると編集直後の変更が反映されないことがある

**チェック内容:** `.claude/workflows/*.js` を編集した直後に動作確認する場合、
`Workflow({ name: "<登録済み名>", args })` ではなく `Workflow({ scriptPath: "<実ファイルの
絶対パス>", args })` で実ファイルを直接指定する。

**なぜ再発したか:** issue #399の調査時、`name`指定（登録済みワークフロー名での起動）は、
直前にスクリプトを編集して保存した直後であっても**古い（編集前の）スクリプト内容で実行される**
ことが実測で確認された。`scriptPath`で明示的にファイルパスを指定した場合は、正しく編集後の
内容が使われた。この挙動の差異が、過去の調査で「同じスクリプトの同じ変数のはずなのに挙動が
違う」という一見矛盾した観測を一部説明していた可能性がある（過去の調査がどちらの呼び出し方を
使ったかは記録が無く確認できないため断定はできない）。

詳細: [`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#issue-399の根本原因確定と修正workflowスクリプトのargs文字列化バグ)

### hookスクリプトのパス正規化漏れとbashの単語境界表現の落とし穴

**チェック内容:** リポジトリパスへの正規表現照合を書く場合、(a) `tool_input.file_path` の
ような絶対/相対混在パスは `os.path.realpath` 等で正規化してから照合する（macOSの `/var` →
`/private/var` シンボリックリンクにより文字列としては一致しないことがある）、(b) bashの
`[[ =~ ]]`（POSIX ERE）で単語境界を表現する場合は `\b` ではなく `[[:space:]]|$` 等の明示的な
境界表現を使う（`\b` はPOSIX EREでは単語境界として解釈されず、パターンごと静かにマッチしなく
なる）。

**なぜ再発したか:** issue #444のPreToolUse hook実装時、`check-run-manifest-presence.sh` は
このリポジトリ自身の名前「medical-inventory-vkumai」に含まれる"inventory"という単語が
ドメインキーワードと単純一致し、リポジトリ内外を問わずあらゆる書き込みで常に誤検知する
自己参照的なバグを起こした（`tool_input.file_path` の正規化漏れ）。`check-direct-ddl-execution.sh`
は `\b` 使用によりコマンド境界判定が静かに失敗していた（`supabase db execute` が検知されない
形でテスト失敗として顕在化）。いずれも「テストを書いて実際に動かす」ことで発見できたバグ。

詳細: [`decisions/aidd-pipeline.md`](./decisions/aidd-pipeline.md#なぜissue-444のpretooluse-hookを警告のみdenyの二段構えにしたか)

### 設計提案・機構追加をgreen方向のみ検証して人間レビューに出す

**チェック内容:** 新しい強制機構（`permissionMode`等のagent frontmatterフィールド、feature flag、
バリデーション、PreToolUse hookのブロック条件等）を追加する提案をする前に、「意図通り動く
（green）」だけでなく「意図通り止める/防ぐ（red）」も実測したか確認する。片方向の検証だけで
「導入してよい」と結論づけていないか、SPEC.md・PR本文・レビュー指摘のいずれかで書く前に
自問する。

**なぜ再発したか:** issue #652で、subagentの`permissionMode: plan`がread-only強制になるという
提案を、Bash(grep)のような読み取り系コマンドが通ることの確認（green）だけで進めかけた。
実際にはlog-agent-progress.sh呼び出し・`echo >`リダイレクト・`mkdir`のような書き込み系
Bashコマンドも許可プロンプト無しで素通りしており、red方向（書き込みを本当に止めるか）を
別途実測して初めて「効果がない」と判明した。green方向だけの確認は「動いた」ことしか
証明せず、「防ぐはずのものを防いでいるか」は別に検証しないと分からない。

**推奨:** 「新しい制御・ゲートを追加する」提案は、成功ケースの実測だけでなく、そのゲートが
防ぐはずの失敗ケースを実際に発生させて防がれるか確認してから提示する。ただしこのチェック
自体は自然言語ルールであり機械強制ではない（`docs/agents/undetectable-rules-inventory.md`
参照）。効果があるのは、提案した本人とは別のエージェント・人間がレビュー時にこのファイルを
参照する場合のみで、meta改修のSPEC自体を別エージェントがレビューする仕組みは現状無い
（2026-08-26時点。将来`adversarial-verify`をmeta改修SPEC提示前にも呼ぶ運用に広げる案は
issue化を検討）。

詳細: [`tooling-decisions.md`](./tooling-decisions.md#subagent-frontmatterのskillsプリロードpermissionmode-planは見送りmaxturnsは延期issue-652)

## RLS/テナント分離層

### 「動いたからOK」でfacility_idフィルタ漏れ・RLS未設定を見逃す（issue #24再発防止）

**チェック内容:** facility/tenant/organizationに触れる新規・変更API（`route.ts`のGET/POST/PUT/
DELETE、RPC関数）をレビューする際は、以下を**攻撃者視点**で確認する
（「自分の施設で正常に動く」ことの確認だけでは不十分）：

1. `requireAuth`（未認証拒否）が全メソッドに付いているか
2. `requireFacilityAccess` 相当（呼び出しユーザーが対象の `facility_id` に所属しているか）の
   チェックがあるか。`facility_id` をクエリパラメータ／パスパラメータ／リクエストボディから
   受け取る箇所は、それを鵜呑みにせず検証しているか
3. **実際に他施設・他テナントの実在するリソースID（例: 他施設の `case_order.id`）を渡して
   アクセスし、403/404で拒否されることを目視確認したか。** 「他施設のIDを知らなければ
   アクセスできない」という推測ではなく、実際にIDを渡して弾かれることを確認する
4. `SECURITY DEFINER` 関数を経由する場合は、上記「SECURITY DEFINER + GRANT EXECUTEの認可
   バイパス」の項目も併せて確認する

**なぜ再発したか:** issue #24で、`products/[id]`・`facilities/[id]`・`categories/[id]`・
`distributor-products/[id]`・`hospital-prices/[id]` のGET/PUT/DELETE、
`distributor-products/[id]/price-history` のGET、`consumables` のPOSTに `requireAuth` が
欠落していたことが、実装から時間が経ってから（別issueのPhase 1調査中に）発覚した。
「エンドポイントを叩いて意図通りのデータが返ってきた」という確認だけでは、認証・認可チェック
自体が存在しないケースを検出できない。

**既存の実装パターン:** `case_orders`/`consumable_orders`/`loan_orders` には他施設IDでの
アクセスを実際に試行するRLS/IDOR統合テストが既にある
（`supabase/__tests__/integration/*-rls-idor.integration.test.ts`、
`e2e/cross-facility-boundary.spec.ts`）。facility/tenantに触れる新規テーブル・APIを
追加する際は同種のテストを追加する。

引き継ぎメモの「検証済み」欄には、他テナントIDでのアクセス確認結果を明示する
（詳細は [`common.md`](./common.md#引き継ぎフォーマット) 参照）。
