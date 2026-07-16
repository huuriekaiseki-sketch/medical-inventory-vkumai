# 機能仕様書 — issue #395: AIDDガードレールのfault injection訓練

> ステータス: **承認済み（停止①クリア）— Phase 3実装へ**
> 作成日: 2026-07-15 / 承認日: 2026-07-15
> 由来: issue #391（evalハーネス基盤）の設計調査で蓄積した知見を流用。Phase 1深掘りは実施せず
> （`.claude/workflows/aidd-phase2.js` 等ハーネス自体への変更にはaidd-phase1 Sweepが対応していない
> ことが判明したため。詳細はpending issue化済み）
> 承認内容: 3点の判断事項すべて決定済み（①定期実施は当面ドキュメントのみ・リマインド機構は見送り
> ②fixture置き場所は`__fixtures__/fault-injection/`のまま ③実測不一致時は即issue化必須、
> decisions.md記録という選択肢は削除）

---

## Part 1 — 仕様（★人間がレビューする部分）

### 背景・課題

issue #348で発覚した`.skip`マーカー回避穴（相対パスでの正規表現すり抜け）は、アドホックなレビューで偶然発見された。`.claude/workflows/aidd-phase2.js`のdeny-by-defaultゲート（Spec Check / Manifest Check / 各フェーズのshouldBlock判定）は、実は**ゲート判定ロジックの純粋関数ミラー**（`quality-gate.js`の`shouldBlock`、`manifest-check.js`の`classifyManifestCheck`、`severity.js`の`isMinorOnlyFailure`）に対する単体テストがすでに存在し、specHash改ざん・承認欠如・severity欠損等の異常系はそのミラー相手にはテスト済みだった（`.claude/workflows/lib/__tests__/`配下）。

しかし各ファイルのコメントに繰り返し明記されている通り、**この純粋関数ミラーは`aidd-phase2.js`の実行パスに配線されていない**。実際のゲート判定は今も「エージェントへの自然言語プロンプト指示」（Read/Bashツールでmanifestを読み、shasumでハッシュ計算し、自分でpass/blockedを判断する）として実行されている。プロンプト文言を変更しても、このミラーとそのテストは自動追従しない（`docs/agents/run-manifest.md`にも明記済み）。

つまり現状のテストは「意図したロジックが正しいこと」しか証明しておらず、**「実際に動いているワークフロー（プロンプト駆動のエージェント）が本当にblockedを返すこと」は一度も実測されていない**。#348のような回避穴は、まさにこの「ロジックは正しいはずだが実行パスは別物」というギャップから生まれる。

### 何ができるようになるか

`aidd-phase2.js`の異常系シナリオ（下記4種）ごとに、**実際のWorkflow（本物のエージェント経由）を実行し、実際にblockedが返ることを実測できる**ようになる。手順は`docs/agents/fault-injection-drill.md`にランブックとして残し、以下のタイミングで人間（またはAI）が手動実行する：

1. `.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更したとき
2. 四半期に1回の定期訓練として

### 対象シナリオ（4種）

| シナリオ | 準備するfixture | 期待される`blockedAt` |
|---|---|---|
| SPEC.md欠如 | `specPath`を存在しないパスに向ける | `Spec Check` |
| Run Manifest欠如 | 有効なSPEC.mdは存在するが`.aidd/run-manifest.json`が無い | `Manifest Check` |
| 承認記録欠如 | `run-manifest.json`は存在し`specHash`はあるが`approval`が無い | `Manifest Check` |
| specHash改ざん | `run-manifest.json`の`specHash`が実際のSPEC.md内容と一致しない（承認後にSPEC.mdが変更されたことを模擬） | `Manifest Check` |

各シナリオで、実行結果の`result.blocked === true`かつ`result.blockedAt`が上記の値と一致することを確認する。

### 運用フロー（人間が見るもの）

1. `scripts/aidd-fault-injection-setup.sh <scenario>` を実行する（実在の`.aidd/run-manifest.json`があれば自動でバックアップする）
2. 表示された`specPath`を使って `Workflow({ name: "aidd-phase2", args: { specPath: "<表示されたパス>" } })` を実行する
3. 返ってきた`result.blocked`と`result.blockedAt`が`docs/agents/fault-injection-drill.md`記載の期待値と一致するか確認する
4. `scripts/aidd-fault-injection-teardown.sh` を実行してバックアップから復元する
5. 4シナリオすべてで一致すれば訓練成功。**1つでも不一致なら、その場で即GitHub Issueを作成する（必須。任意ではない）**。理由: この不一致は「設計判断の記録」ではなく「deny-by-defaultゲートに実際に穴が開いている」という確定した実害の発見であるため（issue #348と同種のパターン）。`docs/agents/decisions.md`への記録に留めて後回しにすることは禁止する
6. 実施した日付・結果（4シナリオ全て一致 or 不一致とissue番号）を`docs/agents/fault-injection-drill.md`の実施記録欄に追記し、同ファイルの「次回実施予定日」を更新する（四半期後の日付を目安に手動で書き換える。リマインド機構は設けない。当面はドキュメント上の日付記載のみで運用し、実際に1〜2回実施を忘れた実績が出た時点で初めて`/schedule`等のリマインド機構を検討する）

> 📸 本機能はCI/`npm test`では自動実行されない（Workflow呼び出しは実際のサブエージェント実行を伴い、Workflow DSL自体はfilesystem APIを持たないためスクリプト側から機械的に起動できない）。動作確認は上記手順を人間またはAIエージェントが手動で1回実施し、4シナリオ全ての`blockedAt`一致をこの場で示すことで行う。

### 受け入れ条件（チェックリスト）

#### fixture・スクリプト

- [ ] `.claude/workflows/__fixtures__/fault-injection/` 配下に4シナリオ分のfixture（`SPEC.md`・`run-manifest.json`の組み合わせ）が用意されている
- [ ] `scripts/aidd-fault-injection-setup.sh <scenario>` が、指定シナリオのfixtureを`.aidd/run-manifest.json`に配置し、実在のmanifestがあれば`.aidd/run-manifest.json.bak`にバックアップしてから上書きする
- [ ] `scripts/aidd-fault-injection-teardown.sh` が、バックアップがあれば復元し、無ければ`.aidd/run-manifest.json`を削除する（訓練前の状態に必ず戻す）
- [ ] 存在しないシナリオ名を渡すとsetup/teardownともにエラーで終了する（exit 0で握りつぶさない）

#### 実測（この場で1回実施し記録する）

- [ ] シナリオ「SPEC.md欠如」で実際にWorkflowを実行し、`blockedAt === 'Spec Check'`を確認した
- [ ] シナリオ「Run Manifest欠如」で実際にWorkflowを実行し、`blockedAt === 'Manifest Check'`を確認した
- [ ] シナリオ「承認記録欠如」で実際にWorkflowを実行し、`blockedAt === 'Manifest Check'`を確認した
- [ ] シナリオ「specHash改ざん」で実際にWorkflowを実行し、`blockedAt === 'Manifest Check'`を確認した
- [ ] 4シナリオ実行後、`.aidd/run-manifest.json`が訓練前の状態（実在していたなら元の内容、無かったなら不在）に復元されていることを確認した

#### ドキュメント・運用

- [ ] `docs/agents/fault-injection-drill.md`にランブック（実行手順・期待値・実施記録欄・次回実施予定日欄）を作成する
- [ ] `docs/agents/common.md`に、`aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際はこの訓練を実施する旨を追記する（検知手段のないルールの棚卸し表への追加、または既存表からの除外いずれか適切な方）
- [ ] 実測で1つでも不一致が出た場合はその場でGitHub Issueを作成する運用であることをランブックに明記する（`docs/agents/decisions.md`への記録に留めて後回しにする選択肢は設けない）

---

### 判断が必要な点（レビュー時に確認・2026-07-15承認済み）

1. **四半期ごとの定期実施をどう思い出す仕組みにするか** → **決定: 当面はドキュメントのみで開始する。**`/schedule`等のリマインド機構は今は作らない。「軽い方から始めて、実際に足りないと分かってから重くする」原則（issue #369の②→①③の順番と同じ）を適用する。ランブックに「次回実施予定日」を1行書く運用とし、実際に1〜2回忘れる実績が出てから初めてリマインド機構を検討する
2. **fixtureの置き場所** → **決定: `.claude/workflows/__fixtures__/fault-injection/`のままでよい。**`__fixtures__`（テストデータ）と`__tests__`（テストコード）はJS界隈で確立された別概念の命名規則であり、混同リスクは低い
3. **失敗時（4シナリオのどれかでblockedAtが一致しない場合）の扱い** → **決定: 即座にissue化を必須とする。**「まず`decisions.md`に記録してから判断する」という選択肢は無くす。理由: この不一致は「設計判断の記録」ではなく「deny-by-defaultゲートに実際に穴が開いている」という確定した実害の発見であり、issue #348と同種のパターンだから。`decisions.md`は設計判断とその理由を残す場所であり、「見つかった実害への対応を後で考えるための待機列」にしてはならない

---

## Part 2 — 実装計画（AI用・技術詳細・レビュー不要）

### 前提

- RISK判定: `.claude/workflows/aidd-phase2.js`本体は変更しない（読むだけ）。触るのは新規fixture・新規スクリプト・新規ドキュメントのみ。`supabase/migrations/`・`src/lib/supabase/`・`middleware.ts`・auth/facility/tenant/organization/inventory/RLS/policyのいずれにも該当しないため、機械判定基準上はSレーン相当だが、実測ステップ（Workflow実際に4回実行）を伴うため通常のS/M/Lの実装規模とは別軸の作業
- DBスキーマ変更は無し（Part 2記載の通りmigrationは不要）
- Workflow DSL自体はfilesystem/Node.js APIを持たないため、setup/teardownはBashスクリプト（`scripts/`配下、既存の`scripts/check-loop-observability-gap.sh`等と同じシェルスクリプト方式）で実装する

### 実装セット一覧（依存順・並列不要な小規模タスクのため単一implementerで直列実施可）

#### セット1: fixture作成

**新規ファイル:**
```
.claude/workflows/__fixtures__/fault-injection/missing-spec/README.md
  （このシナリオはファイル自体を用意しない。setup scriptがspecPathを
  存在しないパスに向けるだけであることを記す）

.claude/workflows/__fixtures__/fault-injection/missing-manifest/SPEC.md
  （最小限の有効なSPEC.md。run-manifest.jsonは意図的に置かない）

.claude/workflows/__fixtures__/fault-injection/missing-approval/SPEC.md
.claude/workflows/__fixtures__/fault-injection/missing-approval/run-manifest.json
  （specHashあり・approvalなし。specHashは実際にこのSPEC.mdから
  `shasum -a 256`で計算した値を埋め込む）

.claude/workflows/__fixtures__/fault-injection/tampered-spechash/SPEC.md
.claude/workflows/__fixtures__/fault-injection/tampered-spechash/run-manifest.json
  （run-manifest.jsonのspecHashは「古い内容」のハッシュ値を固定で埋め込み、
  SPEC.md自体はそれと一致しない別内容にしておく。両者が最初から不一致な
  状態を静的に用意する。「後から変更する」動作は再現しなくてよい）
```

各`run-manifest.json`は`docs/agents/run-manifest.md`のスキーマに従う（`specPath`/`specHash`/`baseCommit`/`changedFiles`/`approval.approvedBy`/`approval.approvedAt`）。

#### セット2: setup/teardownスクリプト

**新規ファイル:** `scripts/aidd-fault-injection-setup.sh`

- 引数: シナリオ名（`missing-spec` / `missing-manifest` / `missing-approval` / `tampered-spechash`）
- 未知のシナリオ名 → `echo "unknown scenario: $1" >&2; exit 1`
- `.aidd/run-manifest.json`が既に存在する場合、`.aidd/run-manifest.json.bak`にコピーしてから対象シナリオのfixture（存在すれば）で上書きする。`missing-manifest`/`missing-spec`シナリオでは`.aidd/run-manifest.json`を削除する（バックアップは取る）
- 標準出力に、後続でWorkflow呼び出し時に使う`specPath`を1行で出す（例: `.claude/workflows/__fixtures__/fault-injection/missing-approval/SPEC.md`。`missing-spec`シナリオでは存在しないダミーパスを出す）

**新規ファイル:** `scripts/aidd-fault-injection-teardown.sh`

- 引数無し
- `.aidd/run-manifest.json.bak`が存在すれば`.aidd/run-manifest.json`に復元し`.bak`を削除する
- `.bak`が存在しなければ`.aidd/run-manifest.json`を削除する（訓練前は存在しなかった前提）

既存の`scripts/check-loop-observability-gap.sh`等と同じシェルスクリプト規約（bash、エラー時は非ゼロexit）に合わせる。

#### セット3: ランブック・共通ルール追記

**新規ファイル:** `docs/agents/fault-injection-drill.md`
- 4シナリオの実行手順（setup → Workflow呼び出し → 期待値確認 → teardown）
- 実施記録欄（実施日・実施者・4シナリオの結果・不一致があった場合の対応issue番号。不一致時は
  「その場でissue化必須」であることを明記し、`decisions.md`への記録に留める選択肢は書かない）
- 「次回実施予定日」欄（四半期後の日付を目安に、実施のたびに手動で書き換える。リマインド機構は
  設けず、この欄への手動記載のみで運用を開始する）

**変更ファイル:** `docs/agents/common.md`
- 「検知手段のないルールの棚卸し（issue #339）」の表に、本ドリルの実施自体が「検知手段」であるゲート（Spec Check・Manifest Check）についての記載を整理する。または新規セクションとして「fault injection訓練の実施タイミング」を追記する（Part 1の判断事項2の結論を反映）

### この場で行う実測ステップ（implementerの作業範囲に含む）

fixture・スクリプトの実装が完了した時点で、implementer自身が4シナリオを順に実行し（setup → 実際に`aidd-phase2` Workflowを呼ぶ → blockedAt確認 → teardown）、結果を`docs/agents/fault-injection-drill.md`の実施記録欄に書き込む。これが受け入れ条件の「実測」項目の実施そのものになる。
