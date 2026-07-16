# 機能仕様書（fault-injection訓練用ダミー） — missing-manifest シナリオ

> これは `docs/agents/fault-injection-drill.md` の「Run Manifest欠如」シナリオ用の
> 最小限の有効なSPEC.mdである。本物の機能実装には使わない。

## Part 1 — 仕様

このSPEC.mdは訓練専用のダミーであり、実際の機能を記述しない。
`.aidd/run-manifest.json`が存在しない状態で`aidd-phase2.js`を実行し、
Manifest Checkが`blockedAt === 'Manifest Check'`を返すことを確認するためだけに使う。

## Part 2 — 実装計画

実装対象なし（訓練用ダミーのため）。
