---
paths:
  - ".claude/workflows/**"
---

# AIDDワークフロープロンプトのeval実行義務（issue #496）

`.claude/workflows/*.js` のプロンプト文言を変更したPRでは、マージ前に `npm run eval:workflows <対応するfixtureセット>`
（sweep系のプロンプト変更は `scripts/eval-sweep-recall.sh <layer>`）を実行し、結果を引き継ぎメモの
「検証済み」欄へ記載すること（未実施の場合はその旨と理由を明記する）。実行完了時に
`docs/agents/eval-runs.jsonl` へ自動記録され、未更新のPRは `.github/workflows/eval-runs-freshness-check.yml` が警告する。

詳細・経緯は [`../../docs/agents/observability-internals.md`](../../docs/agents/observability-internals.md#aiddワークフロープロンプトのevalissue-391) を参照。
