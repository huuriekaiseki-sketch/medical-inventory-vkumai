# Run Manifest

AIDDフロー（Phase 1〜5）が1回の実行の中で「どの仕様書を」「どのコミットを起点に」
「誰が承認したか」を機械的に突合できるようにするための記録。

## 背景

現状、specPath・specHash・baseCommit・changedFiles・承認記録がフェーズ間で分散しており、
「レビュー時に見た仕様書」と「実装時に参照した仕様書」が一致している保証がない。
Run ManifestはこのズレをPhase間で検出するための唯一の正とする。

## 保存場所

```
.aidd/run-manifest.json
```

リポジトリ直下に生成する一時ファイル。フロー実行のたびに上書きされるため `.gitignore` 済み
（コミット対象にしない）。サンプルは [`run-manifest.example.json`](./run-manifest.example.json) を参照。

## スキーマ

| フィールド | 型 | 説明 |
|---|---|---|
| `specPath` | string | 対象SPEC.mdのリポジトリ相対パス |
| `specHash` | string | `specPath` の内容から算出したsha256ハッシュ（承認時点） |
| `baseCommit` | string | 実装の起点となったgitコミットSHA |
| `changedFiles` | string[] | このAIDD実行で変更されたファイルの相対パス一覧 |
| `approval.approvedBy` | string | 停止①（仕様レビュー）を承認した人物 |
| `approval.approvedAt` | string (ISO 8601) | 承認日時 |

## 書き出し・突合タイミング

- **Phase 1完了時**: `specPath` を確定させ、`baseCommit`（現在のHEAD）を記録する。
- **停止①（人間レビュー）承認時**: `specHash` を計算し、`approval` を記録する。
- **Phase 2開始時**: `specPath` の現在のハッシュを再計算し、manifestの `specHash` と突合する。
  一致しない場合はPhase 2を起動せずエラーにする（レビュー後にSPEC.mdが変更されたことを検出するため）。
- **Phase 3〜4完了時**: `changedFiles` を実際の変更ファイル一覧で更新する。

## 関連ファイル

- [`common.md`](./common.md) — 全AIエージェント共通ルール
- [`decisions.md`](./decisions.md) — 各ルールの設計理由
