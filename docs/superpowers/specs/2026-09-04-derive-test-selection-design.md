# 必須テストの機械導出（derive）と 04 の4値検知 設計書（PR②）

日付: 2026-09-04
状態: 口頭承認済み（2026-09-04。分割案A の PR②。前提の設計書は
[`2026-09-02-test-matrix-design.md`](2026-09-02-test-matrix-design.md)）

## 背景

PR①で `docs/agents/test-matrix.md`（テスト一覧）と引き継ぎメモ 04 の4値化を入れたが、
「今回どの種別が必須で、どれが今回不要か」は依然として書く側が表を読んで決めていた。
kojigyo-zei-rag の `scripts/derive-test-selection.sh` は bash の `case` 表でパスを分類していたが、
vkumai には高リスクパス判定の正本（`.claude/workflows/lib/router-risk.js` の `classifyRoute`）が
既にあり、bash の表を並行で持つと必ず乖離する。

また 2026-09-04 の方針で、vkumai は「形式（列・4値・ID 規約）と、それを機械検査する構造テストの
正本」として派生リポジトリへ配る側になった。derive も「エンジン（共通）」と「ルール表（固有）」を
最初から分けて置く。

## スコープ

1. `scripts/lib/derive-test-selection.mjs`（共通エンジン）と
   `scripts/lib/derive-test-selection.rules.mjs`（このリポジトリ固有のルール表）を新設
2. `scripts/derive-test-selection.sh`（git diff を取って本体へ渡す薄いラッパー）と
   `scripts/derive-test-selection.test.sh`（13 シナリオの回帰）を新設
3. `docs/agents/test-matrix.md` に「derive キー」列を追加（証跡の直後、9列目ではなく 7 列目）
4. `scripts/check-test-matrix.test.sh` を 9 列対応にし、derive キー列の双方向整合を検査に追加
5. `scripts/check-handoff-format.sh`（Stop hook）に 04 表の4値検知を追加（警告のみ）
6. `handoff-format` スキルに「derive の出力を貼る」導線を追加
7. `docs/agents/common.md`・`decisions.md`・`portability-inventory.md` を更新

対象外: 約束カタログ（PR③）。`.claude/workflows/lib/` には触れない（読むだけ）。

## 設計

### 1. エンジンとルール表の分離

| ファイル | 区分 | 中身 |
| --- | --- | --- |
| `scripts/lib/derive-test-selection.mjs` | 共通 | 入力解析、`classifyRoute` 呼び出し、ルール評価、JSON / 04 表出力。パス表を持たない |
| `scripts/lib/derive-test-selection.rules.mjs` | 固有 | 1ルール = 一覧の1行。`key` / `label`（= 種別名）/ `timing`（always / on-change / milestone）/ `trigger(ctx)` / `notRequiredReason` / `commands` / `event` |
| `scripts/derive-test-selection.sh` | 共通 | `git diff --name-only <base>...HEAD` を取って `.mjs` へ渡す。`--files a,b` でパイプ無しの注入も可 |

高リスク判定はルール表に書かず、`ctx.route.matchedPaths`（`classifyRoute` の戻り値）を参照する。
`integration-gate.yml` の `paths` 条件のうち高リスク判定に無いもの（`supabase/__tests__/**`）だけ
ルール表側に持つ。

### 2. 出力

- `required`: 毎回の種別（常に）+ 変更時で trigger が hit した種別 + 節目のうち trigger が hit して
  昇格した種別（例: `e2e/` に触れたら E2E をローカル実行）
- `not_required`: 変更時で hit しなかった種別。`notRequiredReason` を 04 の「➖ 今回不要」に貼る
- `milestone`: 節目の種別。「いつ回すか」だけ出す
- `unclassified`: どのパターンにも当たらないパス。新しい層が増えたのにルールが無い、を人に見せる
- `--format table`: 04 表（3列）。required は「⬜ 未実施」で出し、実施後に人が ✅ / 🟡 へ書き換える。
  derive が決めるのは「要るか要らないか」まで。実施したかは人が書く
- `--risk`: `authz_change` / `retry_possible` / `contention` / `external_side_effect`。パスから
  読み取れない性質（再送があり得る等）の申告

### 3. 一覧の derive キー列と構造テスト

列を1つ足したので、検査も同時に足す（「列は機械が検査している間だけ鍵として機能する」）:

- 一覧のキーはルール表に実在する。種別名は `label` と、実施タイミングは `timing`
  （毎回 = always / 変更時 = on-change / 節目 = milestone）と一致する
- ルール表の全キーは一覧に1回ずつ現れる（片方だけ足した状態を拒否）
- derive が判定しない行（➖ 対象外・一度きり）だけ `—` を許す。空欄は違反
- fixture（違反 13 件ちょうど）で RED 方向を自己検証する。ルール表は `TEST_MATRIX_RULES` で注入

### 4. 04 表の4値検知（Stop hook）

`check-handoff-format.sh` は従来「30秒サマリー」「どう確認したか」の見出し有無だけを見ていた。
見出しが揃っていれば、「どう確認したか」節の表行の状態列が4値で始まるか、➖ / ⬜ の行に理由が
あるかを見て、外れた行を**種別名で名指し**して警告する。

block にしない理由: block すると書く側が行を削るか無理に列を埋めて合図が消える。
フォーマットに収まらない行は「書き方の問題」か「一覧に無い種類の確認が出てきた」かのどちらかで、
後者は製品側に新しいリスクが出た合図なので、人が見る。警告文にもその2択を書く。

### 5. Node の版差

`router-risk.js` は `package.json` に `"type": "module"` が無い `.js` の ESM。Node 22.7+ は構文検出で
ESM 扱いするが、CI の `hooks-test` ジョブは `setup-node` を使わず runner 既定の node に依存する。
ラッパーが `--experimental-detect-module` を常に付けて版差を吸収する（24 系でも受理される）。

## 完了条件

1. `bash scripts/derive-test-selection.test.sh` が ALL PASSED（13 シナリオ）
2. `bash scripts/check-test-matrix.test.sh` が ALL PASSED（fixture 13 件違反を含む）
3. `bash scripts/check-handoff-format.test.sh` が ALL PASSED（4値検知の 3 シナリオを含む）
4. PR 本文の 04 が derive の出力を貼った形で書かれ、Stop hook が誤警告しない（PR① の残確認項目 2）
5. `.claude/workflows/` に差分が無い（eval 義務を発生させない）

## リスク

低。scripts / docs / skill のみ。プロダクトコード・DB・認可・CI yml には触れない。
`scripts/*.sh` を触るため derive 自身の判定では hook 実機発火（変更時）が required になる。
Stop hook の変更は fail-open（jq 不在・PR 未検出で沈黙）を維持する。
