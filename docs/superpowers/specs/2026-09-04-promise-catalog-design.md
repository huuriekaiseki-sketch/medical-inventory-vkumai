# 約束カタログ（AAA）設計書（PR③）

日付: 2026-09-04
状態: 口頭承認済み（2026-09-04。分割案A の PR③。前提は
[`2026-09-02-test-matrix-design.md`](2026-09-02-test-matrix-design.md)（PR①）と
[`2026-09-04-derive-test-selection-design.md`](2026-09-04-derive-test-selection-design.md)（PR②））

## 背景

テスト一覧（PR①）は「どの種別のテストがいつ回るか」を、derive（PR②）は「今回どれが必須か」を
決めるが、「そのテストが**何を守っているか**」はテスト名とコメントに散在したままだった。
kojigyo-zei-rag の約束カタログ（1 行 = 1 約束、AAA + 境界値 + 守るテスト）を vkumai に入れる。

ただし kojigyo のカタログは「守るテスト列のファイルが存在する」しか機械検査しておらず、テスト名の
リネーム・削除に追従しない穴があった（実際に P-083 は列が欠け、P-084 は列が余ったまま通っていた）。

## スコープ

1. `docs/agents/promise-catalog.md` を新設。範囲は **auth / RLS / facility 境界 / admin 境界 / AAL2 /
   RPC 契約** に限定し、既存テストが実際に守っている約束 20 件と、守るテストがまだ無い約束 2 件
2. 守るテスト側（統合 15 ファイル・migration 静的 6 ファイル・unit 2 ファイル・E2E 1 ファイル）の
   `describe` / `test.describe` 名に ID `P-xxx` を追記（テスト本体は変えない）
3. `scripts/check-promise-catalog.test.sh` を新設（CI `hooks-test` ジョブで回る）
4. `common.md` / `test-matrix.md` / `decisions.md` / `portability-inventory.md` を更新

対象外: UI・取込・観測基盤の約束（一覧の種別として扱う）。新規テストの追加（`未` の行は
「無い」と書くまで。P-017 の API Route 直接攻撃の自動化、P-052 の同時実行は別 issue）。

## 設計

### 1. 列と ID 規約

列は kojigyo と同じ 9 列（ID / 約束 / Arrange / Act / Assert 肯定 / Assert 否定 / 境界値 / 守るテスト /
実施タイミング）。列は「形式」であり派生リポジトリ共通、行は「中身」で固有。

ID は `P-` + 3 桁、区分ごとに 10 刻み（認証 00x / 施設境界 01x / ロール・admin 02x / AAL2 03x /
RLS 衛生 04x / DB 制約 05x）。欠番は詰めない（PR 本文が ID を参照するため）。

### 2. 逆方向の機械検査（`check-promise-catalog.test.sh`）

- (a) カタログの各 ID が、守るテスト列に書かれた**各ファイルの中に文字列として実在**する
- (b) テストコード（`*.test.ts` / `*.spec.ts` 等）に現れる `P-xxx` は必ずカタログにある（孤児 ID の禁止）
- 9 列、ID 規約、重複、実施タイミング 4 語、`未` 行の扱い（ID 検査を掛けない）、番号帯
- fixture（違反 8 件ちょうど）で RED 方向を自己検証。`REPO_ROOT` をサブシェルで差し替える

これで「テストを消した・名前を変えた」は (a) で、「テストに ID を書いたがカタログに行を足していない」は
(b) で落ちる。`describe` 名に書く（コメントだけにしない）理由は、vitest / Playwright の実行ログにも
ID が出て、失敗した約束を ID で追えるようにするため。

### 3. 一覧・derive との関係

- 実施タイミング「変更時」の約束は、derive が `rls-idor-integration` を required に出す変更で回る
- `未` の行（P-017 直接攻撃の自動化、P-052 同時実行）は一覧の「直接攻撃の実測 🟡」「同時実行 ⬜」と対応する
- 一覧の証跡列とカタログの守るテスト列は重複するが、役割が違う（一覧 = 種別がいつ回るか、
  カタログ = 何を守るか）ので統合しない

## 完了条件

1. `bash scripts/check-promise-catalog.test.sh` が ALL PASSED（fixture 8 件を含む）
2. `npm test`（unit・migration 静的）が green。統合テストは CI `integration-gate` で green
3. `scripts/check-test-matrix.test.sh` が引き続き ALL PASSED
4. PR 本文の 04 が derive の出力を貼った形で書かれている

## リスク

低〜中。テスト本体のロジックは変えず `describe` 名のみ変更だが、`supabase/__tests__/**` に触れるため
`integration-gate.yml` が回る（意図どおり）。ID の埋め込み先が `describe` 名なので、テストの
実行結果に影響は無い。
