# ハーネスの地図（何が揃っていて、どこが空いているか）

**新しいハーネスを作る前にここを見る。** このリポジトリは 3 か月で仕組みを増やし続けてきたので、
「まだ無い」と思って作ったものが既にあることが何度もあった。
[`file-index.md`](./file-index.md) は**ファイル**の索引、[`rulebooks.md`](./rulebooks.md) は
**ルールブック**の索引で、こちらは**役割ごとの地図**（どの層の何を守っているか）。

**「状態」の欄は 2026-09-10 に廃止した。** それまでは手書きの「あり / 一部 / 外部待ち」で、
登録簿自身が「『あり』は中身の十分性を保証しない」と書いていた——
**確かめようのない 1 語**が、事故のとき最初に開く 1 枚でいちばん目立つ場所に載っていたことになる。
同じ問いに 2 か所（この地図と実測の記録）が別々に答える形（E-053）でもあった。

いまは宣言と実測を分けている:

- **この文書（コミットする）** … 機械で実在を確かめられる宣言だけ。
  守る対象の ID・前提・実測の記録の在り処・反証。宣言が実物と食い違えば**生成そのものが落ちる**
- **いま測れているか** … `bash scripts/show-harness-evidence.sh` が実測の記録から出す。
  **測定 / 合格 / 最新 を潰さずに別々に**出す（一度も回していない・赤のまま・木が変わっている、は別の話）。
  記録は機械ローカル（`logs/` は git 管理外）なので、この文書へは焼き込まない

起動の欄（**機械 / 人 / 外部待ち**）は残っている。ここが「人」のものは、誰かが忘れれば止まる。

## 地図

**この節の 2 つの表は生成物。手で編集しない。** 正本は `scripts/lib/harness-registry.json` と
各台帳の実物で、`bash scripts/render-harness-map.sh` で作り直す。
最新かどうかは `scripts/check-harness-map.test.sh`（CI `hooks-test`）が検査する。

**手で書いていたときに 2 回間違えた**（2026-09-09、台帳の数字を取り違え）。
数字は台帳から読み、宣言した入口・検査・限界の文書が**実在するか**も同時に見る。

<!-- generated:harness-map start -->

| 役割 | 何を守るか | 起動 | 入口 | 検査 |
| --- | --- | --- | --- | --- |
| ワークフロー（H-01） | 決めた順番（調査 → 仕様 → 実装 → 統合 → 検証）を飛ばさない。飛ばしたら気づく | **人**（フローの起動は人。**記録漏れの検知だけ**が Stop hook で機械化されている） | `.claude/workflows/aidd-phase1-router.js`<br>`.claude/workflows/aidd-phase2.js` | 32 本 |
| データ（H-02） | テストのデータが互いを壊さない。消しすぎない・消し残さない | **機械**（統合テスト・E2E を回すたびに走行の前後で実測する（走らせるのは人だが、走れば必ず測る）） | `scripts/run-integration-tests.sh`<br>`scripts/run-e2e-tests.sh` | 4 本 |
| 契約（H-03） | 決めたことと動くものが食い違わない（操作の契約・層の突合・入口の検証） | **機械**（npm test と hooks-test が毎回回す） | `npm test`<br>`bash scripts/check-operation-contracts.test.sh` | 35 本 |
| 実装（H-04） | 書いたものが型として通り、単体で動き、ビルドできる | **機械**（npm test / npm run typecheck / npm run lint / next build） | `npm test`<br>`npm run typecheck`<br>`npm run lint` | 8 本 |
| セキュリティ・回帰（H-05） | 施設の境界を越えられない。4 つの入口すべてを総当たりする | **機械**（静的な検査は hooks-test。**実 DB を叩く総当たりは人が起動する**（統合テスト）。攻撃表と実在 route の突合は npm test で毎回（2026-09-10 に E2E から移した。E2E 側に置いていた間は `test.skip` に巻き込まれて Supabase を止めている間ずっとスキップされていた）） | `scripts/run-integration-tests.sh`<br>`bash scripts/check-guard-regressions.test.sh` | 14 本 |
| ミューテーション（H-06） | 検査が本当に効いている（壊したら落ちる）。**その前に、そもそも実行されている**（前提に巻き込まれて黙っていない） | **機械**（判定エンジンの変異（CM）と hook の no-op 化は hooks-test。RLS 変異と Stryker は人が打つが、**打ち忘れは SessionStart hook が拾う**（2026-09-10。木のハッシュで「変わったのに測っていない」を見る。Stryker 側は測る対象の一覧も見張る——対象を減らせばスコアは上がるので）） | `bash scripts/check-detectors-effective.test.sh`<br>`bash scripts/check-rls-mutation.sh`<br>`bash scripts/run-mutation-tests.sh` | 7 本 |
| 監視・観測（H-07） | 起きたことに気づける（夜間検査・鮮度・記録漏れ） | **機械**（夜間検査は pg_cron、鮮度は SessionStart / Stop hook。**hook 自身がこの環境で動くかも SessionStart で毎回見る**（2026-09-11。実測で 42 本中 41 本が jq を呼び、無い環境では 32 本が黙って降りると分かった）。**本番の監視は外部待ち**（#757-8）） | `scripts/check-integration-freshness.sh`<br>`scripts/check-e2e-freshness.sh`<br>`scripts/check-hook-dependencies.sh`<br>`scripts/maintenance-digest.sh` | 38 本 |
| リリース（H-08） | 出す順番を間違えても壊れない（順序・巻き戻し・ロック） | **機械**（hooks-test が migration の注記を毎回検査する。**マージ予行は人が打つ**（bash scripts/rehearse-merge.sh --base main）） | `bash scripts/check-migration-release-safety.test.sh`<br>`bash scripts/rehearse-merge.sh` | 3 本 |

**契約（守る対象・前提・実測の記録・反証）**

| 役割 | 守る対象 | 前提 | 実測の記録 | 反証（壊して落ちることの確認） |
| --- | --- | --- | --- | --- |
| ワークフロー（H-01） | —（守る対象は業務の条件ではなく手順そのもの。台帳の ID では表せない） | 人（またはエージェント）が AIDD フローを起動していること | —（フローの実行そのものは人が起動するので「最後に回した結果」を持たない。記録漏れの検知だけが Stop hook で機械化されている） | scripts/check-rule-guard-effective.test.sh（hook を no-op にすると検査が落ちるか） |
| データ（H-02） | `C-030` `C-041` `E-065` | ローカル Supabase が起動していること。統合テスト・E2E を全件で回すこと（部分実行では判定しない） | 統合テストの全件実行（後片付けの漏れを含む）<br>`logs/integration-runs.jsonl` | 変異 CM-011 / CM-018 / CM-024（scripts/lib/check-mutants.json） |
| 契約（H-03） | `C-010` `C-011` `C-032` | なし（静的な突合だけ。実 DB は要らない） | —（毎回の npm test と hooks-test で回るので「最後に回した記録」を別に持たない（回っていなければ CI が赤になる）） | 変異 CM-001〜CM-010 / CM-019〜CM-021 / CM-025 / CM-026（scripts/lib/check-mutants.json） |
| 実装（H-04） | —（型・単体・ビルドは特定の条件ではなく全体に掛かる。台帳の ID では表せない） | なし | —（毎回の CI で回るので「最後に回した記録」を別に持たない（回っていなければ CI が赤になる）） | scripts/check-fail-open.test.sh（材料が取れないときに拒否側へ倒れるか） |
| セキュリティ・回帰（H-05） | `T-037` `C-023` `C-032` `P-017` | ローカル Supabase が起動していること。E2E は dev サーバーも要る。**ただし『実在する route が攻撃表に載っているか』の突合だけは前提なし**（ファイルを読むだけなので npm test で毎回回る） | E2E の全件実行（画面と入口の総当たり）<br>`logs/e2e-runs.jsonl` | scripts/check-guard-regressions.test.sh（後から足した守りを落としたら落ちるか） |
| ミューテーション（H-06） | `C-022` `C-033` | RLS 変異はローカル Supabase が起動していること。Stryker は実 DB を要らない | 認可ポリシーの変異計測（RLS）<br>`logs/rls-mutation-runs.jsonl`<br><br>製品コードの変異計測（Stryker）<br>`logs/mutation-runs.jsonl` | この役割自体が反証の仕組み。自分を壊しては測れないので、scripts/check-detectors-effective.test.sh の scenario 2〜9 が fixture で自己検証する |
| 監視・観測（H-07） | `C-041` `E-030` | なし（記録が無いこと自体を警告するので、記録が無くても動く） | —（この役割は「他の役割が測ったか」を見る側で、自分の実測の記録は持たない。鮮度 hook が黙る事故は各 *-freshness.test.sh が測る） | scripts/check-rule-guard-effective.test.sh（鮮度 hook を no-op にすると落ちるか） |
| リリース（H-08） | `M-010` | なし（migration の SQL と git の状態だけを見る） | マージ予行（この順で main へ入れたら衝突するか）<br>`logs/release-rehearsal-runs.jsonl` | scripts/check-migration-release-safety.test.sh の RED 方向 fixture |

**台帳（数字はここから読む。足し算しない）**

| 台帳 | 何を数えているか | 単位 | いま |
| --- | --- | --- | --- |
| `integration-leak-baseline.json`#maxLeakedRows | 統合テストの消し残しの上限（H-02） | 緑の全件実行 1 回で業務表に残る行 | **0** |
| `input-validation-baseline.json`#pending.length | 本文を検証せずに読む route（H-03） | route | **0** |
| `query-validation-baseline.json`#pending.length | クエリを検証せずに読む route（H-03） | route | **0** |
| `write-path-registry.json`#maxGaps | DB は書けるのにアプリに道が無い組み合わせ（H-05） | 組み合わせ | **0** |
| `exemption-budget.json`#max.eslint-disable | 検査の逃がし口（上限。eslint-disable）（H-06） | 件 | **14** |
| `check-mutants.json`#minMutants | 判定エンジンの壊し方（下限）（H-06） | 件 | **76** |
| `rls-mutants.json`#mutants.length | RLS・RPC の壊し方（H-06） | 件 | **20** |

（ハーネス 8 件・検査 141 本・台帳 7 件。うち `scripts/**/*.test.sh` の 140 本は**この表で全数**——どこにも属さない検査があれば生成そのものが落ちる。残り 1 本は vitest 側から**手で足したもの**で、書き忘れは検知されない（限界の節））

<!-- generated:harness-map end -->

**「起動」の欄がいちばん大事。** ここが `人` のものは、誰かが打たなければ止まる——
つまり**つながっていない**。`機械` に変えられるものから変えていく。

## いま空いているところ（状態が「一部」の中身）

**手が届くもの**:

| 空き | どこ | なぜ残っているか |
| --- | --- | --- |
| 応答時間の差から存在を推測できるか | 脅威 T-013 | 外部公開前に引き出し（`security-test-catalog.md`）から開ける |
| 変異計測（Stryker・RLS）を打つのは人のまま | `run-mutation-tests.sh` / `check-rls-mutation.sh` | CI に載せられない（Stryker は Actions の無料枠、RLS は実 DB を作り直す）。**2026-09-10 に「打ち忘れ」だけは機械が拾うようにした**——木が変わったのに測っていなければ SessionStart で警告する。打つのは人（#757 の 6・7） |

**外部への到達が要るもの**（GitHub / Supabase cloud が戻るまで着手できない）:

| 空き | 番号 |
| --- | --- |
| 本番の監視（拒否率・権限エラー・取得量の異常でアラート） | #757-8 |
| staging と production の設定ドリフト比較 | #757-35 |
| バックアップからの復元と、復元後の検証 | #757-11・23 |
| 鍵のローテーション（旧鍵が全経路で無効になるか） | #757-29 |
| 既存行が NOT VALID の CHECK に違反していないか（本番データを見て VALIDATE する） | I-066 |

## 借金の数字の読み方（**2 回取り違えたので先に書く**）

ratchet を持つ仕組みはそれぞれ**別の台帳**を持っている。**足し算しないし、比べられない。**

**一覧と現在値は上の「地図」の 2 つ目の表**（生成物）にある。ここには読み方だけを書く。


**新しい検査を作ると、それまで誰も数えていなかったものが台帳に載る。**
0 だった数字が 13 になったように見えても、増えたのは**見えている範囲**であって借金そのものではない。
2026-09-09 にこの取り違えが 2 回起きた（1 回目は「触れるが何も起きない道」を新設したとき、
2 回目はクエリ文字列の検証を新設したとき）。

数字を報告するときは、**どの台帳か・何を単位に数えたか**を必ず添える。
同じ日に「12 route / 29 か所」と「13 route / 30 か所」の 2 つの数字を書いてしまったことがある——
前者は**引数の名前の種類**、後者は**`.get(` の呼び出し箇所**で、数える単位が違っていた（C-031）。

## 読み方

- **宣言があっても守っているのは書いてある範囲だけ。** 各ハーネスの限界はそれぞれのファイルの
  「限界」節にある。ここには書かない（2 か所に書くと必ず片方が古くなる）
- **「いま緑か」はこの文書からは分からない。** `bash scripts/show-harness-evidence.sh` を打つ。
  この文書が答えるのは「何を守ると宣言しているか」までで、
  「その宣言どおりに最後に測れたのはいつか」は実測の記録が答える
- **役割が重なっているものがある。** 例えば「入口の検証」と「層の突合」はどちらも zod を見るが、
  前者は**入口を 1 つにする**こと、後者は**DB と値が一致する**ことを見ている
- **新しく作りたくなったら、まず上の表のどの行かを決める。** 行が無ければ新しい役割で、
  行があるなら既存のものを広げるほうが早い（このリポジトリでは後者のほうが多かった）

## 限界

- **宣言の実在は見るが、中身の十分性は見ない。** 守る対象の ID が台帳にあること・記録の在り処が
  実在することは機械で確かめるが、その検査が本当に守れているかは見ない（それは変異計測 H-06 の担当）
- **証拠の状態は HEAD の木のハッシュだけを見る。** 未コミットの書き換えは見ない
  （そちらは Stop hook の `scripts/check-full-run-before-finish.sh` の担当。
  同じ問いに 2 か所が別々に答えないようにしている）
- **実測の記録を持たない役割がある。** H-01（ワークフロー）・H-03（契約）・H-04（実装）・
  H-07（監視）・H-08（リリース）は「最後に回した結果」を持たない。理由は上の契約の表に書いてある。
  持たない理由が「CI が毎回回すから」の場合、**CI が止まっていれば誰も気づかない**
- **逆向きの ratchet が数えるのは `scripts/*.test.sh` と `scripts/lib/*.test.sh` だけ。**
  `npm test`（vitest）側の検査を足しても「どこにも属さない検査」としては落ちない。
  登録簿に**書けば**実在は確かめられるが、**書き忘れは検知されない**。
  2026-09-10 にこの限界が実際に現れた——攻撃表の ratchet を vitest へ移したとき、
  登録簿の合計は 130 になったが hook 回帰が回すのは 129 本で、
  **差の 1 本（`src/__tests__/api-attack-matrix-ratchet.test.ts`）は手で登録したから表に載っている**。
  vitest のテストは 242 ファイルあるので全部を登録簿に載せるのは現実的でなく、
  いまは「役割を持たせたい検査だけ手で足す」運用になっている
- 役割の切り方はこのリポジトリの都合で、一般的な分類ではない

## 更新の引き金

- 新しいハーネスを作ったとき（行を足す）
- 状態が変わったとき（外部待ちが解けた・借金が 0 になった）
- 空きを埋めたとき（「いま空いているところ」から消す）
