---
paths:
  - ".claude/workflows/**"
---

# AIDDワークフロープロンプトのeval実行義務（issue #496）

`.claude/workflows/*.js` のプロンプト文言を変更したPRでは、マージ前に `npm run eval:workflows <対応するfixtureセット>`
（sweep系のプロンプト変更は `scripts/eval-sweep-recall.sh <layer>`）を実行し、結果を引き継ぎメモの
「検証済み」欄へ記載すること（未実施の場合はその旨と理由を明記する）。実行完了時に
`docs/agents/eval-runs.jsonl` へ自動記録され、未更新のPRは `.github/workflows/eval-runs-freshness-check.yml` が
**失敗させる**（2026-09-05 に warning から変更。warning は run を開かないと見えず 3 件の PR で無視されたため）。
コメント修正・定数変更・配線のみなど eval が不要な変更は、PR 本文に行頭で `eval-skip: <理由>` と書けば通る
（理由は空にしない。本文に残るので後から追える）。

## 改善を採用する条件（issue #907、2026-10-24）

Anthropic「Automating eval design and hillclimbing」（2026-09-28）の過学習対策を取り込んだもの。
deep ルートの Find プロンプトを締めて recall が 11/17 → 5/17 に落ちた件（issue #796）は、この型で防ぐ。

- **採用は train と test の両方が改善し、改善幅がノイズ幅より大きいときだけ。** 変更前（main）と変更後を、
  調整に使う train セット（`scripts/eval-fixtures/<set>`）と評価専用の test セット（`<set>-holdout`、held-out）の
  両方で `EVAL_RUNS=3`（以上）で回し、記録の `noiseWidth`（run 間の最大 − 最小）より大きい改善が両方にあるときだけ
  `scripts/record-eval-decision.sh --decision adopted --before-train <ts> --after-train <ts> --before-test <ts> --after-test <ts> --change "<1 行>"`
  で `docs/agents/eval-decisions.jsonl` に残す。条件を満たさない結果では**「採用」と書けない**（スクリプトが拒む）。
  1 run の記録はノイズ幅を持たないので根拠にならない。見送るときも `--decision rejected` で記録を残す。
  test セットが無いプロンプト（db-impl / spec-check）は、変える前に `<set>-holdout` を 1 case 作る。
- **1 ラウンド 1 パッチ。** 1 回の採用判定で変えるのはプロンプト・探索手順の 1 か所だけ。
  同時に 2 つ変えると、どちらが効いたか記録から追えない（`--change` に 1 行で書けないなら分ける）。
- **失敗したケースの本文をプロンプトに貼らない。** eval で落ちた case の fixture のコード・ファイル名・期待キーワードを
  プロンプトや `.claude/agents/*.md` へ写さない。held-out の名前は `scripts/check-holdout-isolation.test.sh` が
  機械で見張るが、train 側は人の規律。写せば eval はその case だけを覚え、本番の見逃しは減らない。
- 記録の形と採用記録は `scripts/check-eval-record-shape.test.sh` が検査する。eval を回さない PR は今までどおり
  `eval-skip: <理由>` でよい。

詳細・経緯は [`../../docs/agents/observability-internals.md`](../../docs/agents/observability-internals.md#aiddワークフロープロンプトのevalissue-391)
と同ファイルの「ノイズ幅と held-out」の節を参照。
