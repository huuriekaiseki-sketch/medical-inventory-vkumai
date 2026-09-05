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

さらに**admin境界**（`findAdminOnlyTablesWithoutTest`）も同じ型で検知する。
`categories` / `distributor_products` / `products` / `product_compatibilities` / `facilities` は
SELECTが `USING (true)` でテナント非分離のため施設境界の軸からは除外されるが、
**書き込みだけが `is_admin()` に限定される**という別の約束を持つ。除外したまま
admin側の軸を作らないと「面倒な指摘を除外リストに逃がしただけ」になるため対で運用する。
`is_facility_member` / `is_facility_writer` との OR は「adminは追加の許可」であって
境界ではないので対象外（この区別を入れないと15テーブルが該当しノイズになる。実測確認済み）。

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

### CI・hook が npm レジストリに毎回依存する（`npm install` / `npx -y tsx`）

**チェック内容:** `.github/workflows/*.yml` の install ステップは `npm ci`（`npm install` は使わない）。
hook スクリプト（`scripts/*.sh`）から TypeScript / ESM を実行するときは `npx` を使わず
`node --experimental-strip-types`（.ts）/ `node --experimental-detect-module`（.js）で直接実行し、
その import 連鎖の相対 import には拡張子（`.ts` / `.js`）を付ける。
`scripts/check-no-registry-fetch.test.sh`（CI `hooks-test`）が 3 点とも機械検査する。

**なぜ再発したか（2026-09-04）:** CI が平常時の 4〜8 倍かかった。ジョブ内訳を取ると本体の
実行時間は不変で、(1) `npm install` が 15 秒 → 300 秒（キャッシュ命中でもロックがあっても
依存解決でレジストリへ行く）、(2) hooks-test の月次チェック回帰が 51 秒 → 425 秒（`npx -y tsx`
が tsx を毎回ダウンロード。tsx は devDependencies に無く、hooks-test は node_modules 無しで走る）。
レジストリが遅い日にだけ露出するため、コード変更と無関係に「CI が急に遅い」として現れる。
同じ `npx -y tsx` は 6 本の hook スクリプトに散在していた（1 本直しても残りで再発する）。

**副次的に見つかったこと:** `npm ci` に切り替えた初回 CI で「ロックファイルに
`@emnapi/runtime` / `@emnapi/core` が無い」と失敗した。`npm install` はこの不整合を黙って補って
いたため、それまで検知されなかった。`npm ci` の失敗は正しい検知なので、`npm install` に戻さず
ロックを直す（`npm install --package-lock-only`。CI と同じ npm の版で行う）。

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

**再発（2回目、2026-09-05、issue #713）:** subagent frontmatterの`hooks.PreToolUse`で
読み取り専用ロールのBashをdenyする機構を、shellテスト（hookスクリプト単体にJSONを流す）が
green・RED両方向で通ったことを根拠にPRへ進めかけた。Agent tool経由でsweep-uiを実際に起動し
`mkdir`・リダイレクト・`sed -i`を打たせると全て素通りし、実体ファイルも作成された（trust承認
済みのフォルダで、原因は未特定）。スクリプト単体のテストは「スクリプトが正しく判定する」こと
しか証明せず、「その経路でhookが本当に呼ばれる」ことは実行系（Claude Code本体）でしか確認
できない。settings.jsonのPreToolUse（`agent_type`判定）に切り替えて同じ手順で再実測し、
denyを確認してからPRにした。**hookの追加は、スクリプト単体テストに加えて「実際にその
ツールを呼ぶ主体（サブエージェント・Workflow）から」のRED実測を1回取る**ことを要求する。


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

## 依存関係層（npm サプライチェーン）

### npm パッケージの追加を「部品を増やす作業」として通してしまう（2026-09-04）

**チェック内容:** package.json / package-lock.json に触れる変更では、追加・更新・削除した
パッケージごとに **用途 / 代替案（既存の依存・標準 API で足りない理由）/ 権限・環境変数・DB への
影響 / 固定した版と出所（registry.npmjs.org）/ `npm ci` と `npm audit --omit=dev --audit-level=high`
の結果 / ロールバック方法** を引き継ぎメモ 00 欄「依存の変更」に書く。見覚えのない間接依存は
`npm explain <pkg>` で起点を辿る。npm audit が緑でも「安全の証明」ではない（公開済み脆弱性に
当たっていないことしか分からない）。

**なぜ気づきにくいか:** 悪意ある部品が入ってもアプリは普通に動き、追加分は大量の lockfile 差分や
間接依存に紛れる。lockfile に見覚えのない名前が多いこと自体は異常ではないので、名前だけでは
判断できない。混入経路は「AI / 共同作業者が用途を説明できない直接依存を足す」「正規パッケージの
保守者アカウント乗っ取り」「正規パッケージの間接依存の侵害」の 3 つで、事後のスキャンは 3 つ目
しか見ない。

**機械検知（検査名ごとに見つけられる事故が違う。ひとまとめに「テスト済み」と報告しない）:**

| 検査 | 実体 | 分かること | 分からないこと |
| --- | --- | --- | --- |
| 追加の瞬間の人間確認 | PreToolUse `scripts/check-dependency-change.sh`（ask。Codex は deny） | AI が無確認に依存を足す・package.json を書き換える | 人が承認した依存の内部 |
| 依存差分レビュー | Stop `scripts/check-handoff-format.sh`（package.json 変更 PR に「依存の変更」が無ければ警告） | 説明の無い依存変更 PR | 記述の中身の妥当性 |
| クリーンインストール | CI 全ジョブの `npm ci`（`npm install` は `scripts/check-no-registry-fetch.test.sh` で禁止） | package.json と lockfile の不整合、PC だけで動く依存状態 | lockfile に既に入った悪意ある部品 |
| ロックファイルの出所 | `scripts/check-lockfile-integrity.test.sh`（hooks-test） | レジストリ外の出所、integrity 欠落、git / file / http 指定 | レジストリ上の正規パッケージ内部の悪意 |
| 既知脆弱性 | CI `dependency-audit` ジョブ（`npm audit --omit=dev --audit-level=high`） | 公開済み脆弱性 | 未公表の攻撃、登録されていない悪意あるコード |
| Dependabot | `.github/dependabot.yml`（weekly） | 古い版の放置 | 新版そのものの侵害 |

**入ってしまったら:** 疑いのある変更を含むデプロイを止め、安全だったコミットへ戻し、侵害期間中に
読まれた可能性のある認証情報（GitHub・Supabase・DB・外部 API）をローテーションし、信頼できる
コミットからクリーン環境で `npm ci` して再ビルドする。パッケージを消すだけでは、既に読まれた
認証情報は取り戻せない。

**実例（2026-09-04）:** `npm ci` へ切り替えた初回 CI が「lockfile に `@emnapi/runtime` /
`@emnapi/core` が無い」と失敗した。悪意ではなく `npm install` が黙って補っていた不整合だったが、
「lockfile に見覚えのない名前が出た」ときに **出所（レジストリ URL・公開者・integrity）と起点
（`npm explain`）を確認して判断する** 手順の実演になった。

### ロックファイルをローカルの npm で更新すると CI の npm と食い違う（2026-09-04）

**チェック内容:** package-lock.json を更新するときは、**CI ランナーと同じ npm の版**で行う
（`npx -y npm@<CI の npm 版> install --package-lock-only`。CI の版は setup-node のログ
「Environment details」に出る）。ローカルの Node に同梱された npm（例: 24.11 の 11.6）と CI の
Node 24 最新（例: 24.20 の 11.19）は版が違い、新しい npm はロックに要求する項目が多い。

**なぜ再発したか:** 同日に 2 回起きた。1 回目は既存ロックの欠落、2 回目は 11.19 で直したロックを
ローカルの 11.6 で `npm install next@… --package-lock-only` した際に、11.6 が `@emnapi/*` の項目を
「不要」と判断して落とした。ローカルの `npm ci --dry-run` は 11.6 なので通り、CI の 11.19 だけが
落ちる。**ローカルで通ったことは CI で通る証拠にならない**（版が違う）。
