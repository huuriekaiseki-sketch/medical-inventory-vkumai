# テスト一覧と「04 どう確認したか」の4値化 設計書（PR①）

日付: 2026-09-02
状態: 口頭承認済み（2026-09-02、分割案A: ①一覧＋04の4値化 / ②derive の理由出力 / ③約束カタログ）

## 背景

kojigyo-zei-rag（PR #8〜#10）で「テスト一覧（何を・いつ・なぜ）」「約束カタログ（AAA）」
「必須テストの機械導出（derive）」の3点セットを導入し、PR本文の「⬜未実施」が
「今回不要」なのか「穴」なのかを機械が区別できるようになった。

vkumai にはこの相当物が無い。引き継ぎメモ（`handoff-format` スキル）の「04 どう確認したか」は
自由記述で、確認範囲がAIごとにブレる（issue #666 で指摘済みの症状）。テスト種別ごとの
「いつ回るか」（PRごとCI / 高リスクパスのみ / mainマージ後 / 日次cron / 手動）も
ci.yml・integration-gate.yml・e2e.yml・schema-drift-check.yml・fault-injection-drill.md に
散在しており、一覧で読める場所が無い。

## スコープ（PR①）

1. `docs/agents/test-matrix.md` を新設する
2. `.claude/skills/handoff-format/SKILL.md` の 04 を表形式・4値固定にする
3. `scripts/check-test-matrix.test.sh` を新設し、一覧とスキルの整合を機械検査する
4. `docs/agents/common.md` から一覧へのポインタを追加する
5. `docs/agents/decisions.md` に設計判断を2項目追加する

対象外（後続PR）:
- PR②: `router-risk.js`（`classifyRoute`）を土台にした「今回必須 / 今回不要（理由付き）」の
  機械導出と、一覧への「derive キー」列の追加。`check-handoff-format.sh` の4値検知もここ
- PR③: auth / RLS / facility 境界に限定した約束カタログ（`P-xxx`）。テスト側に ID を書き、
  「カタログの全 ID がテストコードに出現する」を逆方向で機械検査する

## 設計

### 1. テスト一覧 `docs/agents/test-matrix.md`

1行 = テスト種別。列は固定:

| 列 | 内容 |
| --- | --- |
| 種別 | 型検査 / lint / unit / build / hook回帰 / ワークフロー同期 / migration / DB制約ratchet / RLS/IDOR統合 / E2E / スキーマドリフト / fault injection訓練 / hook実機発火 / agents baseline / 冪等性 / 同時実行 / 障害注入 |
| 状態 | ✅ ある（証跡付き）/ 🟡 一部 / ⬜ 未整備 / ➖ 対象外（理由必須） |
| 実施タイミング | 毎回（CI が全 PR で自動）/ 変更時（paths フィルタ・高リスク判定）/ 節目（mainマージ後・日次cron・四半期・公開前）/ 一度きり |
| トリガー | CI の paths 条件、hook、cron、または人が起動するイベント名 |
| 理由 | なぜこの種別が要るか、または要らないか |
| 証跡 | テストファイル・ディレクトリ・CI ジョブ名・記録ファイルのパス |
| 相場 | 外部の物差し（Google Small/Medium/Large、OWASP ASVS、テストピラミッド） |
| コマンド | ローカルで実行するコマンド。手動のものは `(手動)` を付ける |

ファイル名は `test-inventory` ではなく `test-matrix` とする。`router-risk.js` の
`RISK_DOMAIN_KEYWORDS` に `inventory`（在庫ドメイン）が含まれ、`test-inventory.md` という名前は
パスベース高リスク判定に恒久的に誤一致する（設計書作成時に PreToolUse hook が実際に警告した）。

kojigyo にある「derive キー」列は PR② で足す。今回は入れない（スクリプトが無いのに列だけ
あると、構造テストで縛れない空欄になるため）。

状態記号に ❌ は使わない。kojigyo で「❌ 無い」が「失敗・問題あり」と読まれたため ⬜ に改めた
経緯を踏襲し、PR テンプレート側の ⬜ と体系を揃える。

### 2. handoff-format スキル 04 の4値化

「04 どう確認したか」を表形式にし、状態を4値に固定する:

| 状態 | 意味 |
| --- | --- |
| ✅ 実施 | `(手動)` か `(自動テスト)` かを書き分ける |
| ➖ 今回不要 | 理由必須。PR② 以降は derive の出力をそのまま貼る |
| 🟡 一部 | 何を残したかを書く |
| ⬜ 未実施 | 必要なのに未実施。理由必須。原則マージ不可 |

行は一覧の「毎回」「変更時」の種別に揃える。「節目」の種別は該当しない限り行を省略してよい。
既存の記述項目（`npm run ai:check` の実行有無、fault injection、実測かサンプルか、
verify-claims の実施有無）は表の下に残す。

### 3. 構造テスト `scripts/check-test-matrix.test.sh`

既存の `scripts/*.test.sh` と同じ書式（scenario ごとに OK/NG、最後に ALL PASSED / FAILED）。
CI の `hooks-test` ジョブが `scripts/*.test.sh` を全件実行するため、CI 側の変更は不要。

検査項目:
1. 一覧ファイルが存在する
2. 状態 ✅ の行は証跡列が空・`—`・`未` でない
3. 証跡列に書かれたパス（バッククォート囲みで `.ts` / `.sh` / `.js` / `.md` / `.yml` / `.json` /
   ディレクトリ `xxx/` に一致するもの）がリポジトリに実在する
4. 実施タイミング列の値が「毎回 / 変更時 / 節目 / 一度きり / —」のいずれかである
5. `handoff-format/SKILL.md` に「➖ 今回不要」と「⬜ 未実施」の文言がある

fixture による RED 確認: 証跡が `—` の ✅ 行と、存在しないパスを証跡に書いた行を持つ一時ファイルを
`TEST_MATRIX_PATH` 環境変数で差し替え、NG になることをテスト自身の scenario として含める
（既存の hook テストが環境変数注入で fixture を渡す方式と同型）。

### 4. common.md からのポインタ

「引き継ぎフォーマット」節の直後に、一覧が「テスト種別ごとの実施タイミングと証跡の正本」であり、
04 の行は一覧の種別に揃えることを1段落で書く。common.md は常時ロードされるため、一覧本体は
埋め込まず参照のみとする（issue #486 の圧縮方針）。

### 5. decisions.md への追記

- なぜ derive（機械導出）を PR② に分けたか: `.claude/workflows/lib` を触るとワークフロー eval 義務
  （`.claude/rules/workflow-eval-requirement.md`）と sync test が絡み、文書のみの PR① と
  レビュー単位を分けたい。また一覧が先に存在しないと derive の `not_required` 理由文の対応先が無い
- なぜ状態記号に ❌ を使わないか: 上記 1. の経緯

## 完了条件

1. `bash scripts/check-test-matrix.test.sh` が ALL PASSED
2. fixture 差し替え時に NG になる scenario がテスト内に含まれ、PASS している
3. 一覧の全行が 2026-09-02 時点の実態を正直に反映している（⬜ を ✅ に書き換えていない）
4. PR 本文自身が新しい 04 表形式で書かれている
5. `bash scripts/check-handoff-format.test.sh` など既存の hook テストが引き続き PASS する

## リスク

低。文書・スキル・テストスクリプトのみ。プロダクトコード・DB・認可・CI yml には触れない。
TRI/RISK 判定上は `docs/agents/` と `.claude/skills/`・`scripts/` の変更であり、高リスクパスに
該当しない。
