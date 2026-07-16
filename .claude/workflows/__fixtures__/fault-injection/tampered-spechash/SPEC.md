# 機能仕様書（fault-injection訓練用ダミー） — tampered-spechash シナリオ

> これは `docs/agents/fault-injection-drill.md` の「specHash改ざん」シナリオ用の
> 最小限の有効なSPEC.mdである。本物の機能実装には使わない。

## Part 1 — 仕様

このSPEC.mdは訓練専用のダミーであり、実際の機能を記述しない。
対応する`run-manifest.json`の`specHash`は、このファイルの実際の内容とは異なる
固定のハッシュ値をあらかじめ埋め込んでおり、承認後にSPEC.mdが変更されたことを模擬する。
`aidd-phase2.js`実行時にManifest Checkが`blockedAt === 'Manifest Check'`を返すことを
確認するためだけに使う。

## Part 2 — 実装計画

実装対象なし（訓練用ダミーのため）。
