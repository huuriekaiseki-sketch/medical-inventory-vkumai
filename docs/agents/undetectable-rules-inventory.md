# 検知手段のないルールの棚卸し

[`common.md`](./common.md) から分離した参照ドキュメント（issue #542。`/doctor`実行結果を踏まえ、
参照頻度が低く常時ロードする必要のないブロックをcommon.mdから切り出す方針。issue #445の
path-scoped rules化とは異なり、特定パスに紐づかない内容のため別ファイル化＋ポインタ参照とした）。

新しい運用ルールを書く前は必ず[`decisions.md`の該当原則](./decisions.md#なぜ新しい運用ルールに検知手段を先に決める原則を導入したかissue-339)を先に読むこと。
特に、新しい検知・検証メカニズム自体を追加する際は「その起動トリガーは機械（hook/CI/cron/npm test）
か人か」を先に確認すること（issue #411）。人起動なら第3層ルールの削減ではなく追加になるだけで、
下記棚卸し表に行が1つ増えて終わる。
以下は2026-07-14時点で「破られても機械的に気づく手段がない」ルールの一覧（第3層）。
検知手段を実装したら、このルールの説明に検知手段へのリンクを追記してこの表から外すこと。

| ルール | 所在 | 備考 |
|---|---|---|
| ブランチ運用ルール（`origin/main`起点でのbranch作成） | [`common.md`](./common.md)「ブランチ運用ルール」 | 過去に古いローカル`main`起点でbranch作成し手戻りが発生した実績あり。着手前PR確認のうち「マージ済みPRが乗っている」ケースは`scripts/check-branch-pr-status.sh`（SessionStart hook）で検知済み。**`origin/main`起点確認自体もissue #499で部分検知済み**（`scripts/check-local-main-freshness.sh`。FETCH_HEAD鮮度・ローカルmainの遅れコミット数による近似判定、fetchはhook内で実行しないため取りこぼしうる）。「別issueの未マージPRが乗っている」ケース（マージ前の分岐）は引き続き未検知のまま |
| サーキットブレーカー（`/goal`設定・テスト修正3回まで・フロー全体上限） | ルートの`CLAUDE.md` | issue #441で検知手段を調査したが、「`/goal`が設定されているか」を外部から機械的に問い合わせるAPI/hookは公式に存在しないと判明（実機確認済み）。条件テンプレート化・役割分担の明文化（Workflow内部retryとの切り分け）は完了したが、呼び忘れ自体の検知は依然できないままこの表に残る |
| 停止①②以外で止まらず自律進行すること | ルートの`CLAUDE.md`「絶対ルール」 | |
| gap check stateの記録（`record-gap-check-state.sh` before/expectedの呼び出し） | ルートの`CLAUDE.md`「gap check state 記録ルール」 | gap check本体の実行はissue #488でStop hookに機械化済み。ただしこの記録呼び出し自体の呼び忘れ検知は無い（Workflow DSLがfilesystem API不可のため自己申告依存が残る。AIDD statsのphase単位呼び出しと同型の限界だったが、そちらはissue #524で検知済みになった） |
| seed・スクリーンショットに実在施設名を使わない | [`common.md`](./common.md)「テスト環境・データ衛生ルール」 | per-edit層で部分検知（`.claude/security-patterns.json`の`possible_real_facility_name`、issue #440）。ただし`/plugin install security-guidance@claude-plugins-official`の実機有効性は未確認、かつスクリーンショット・issue添付・E2E失敗ログは検知対象外 |
| `aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際のfault injection訓練の実施自体 | [`common.md`](./common.md)「fault injection訓練の実施タイミング（issue #395）」 | 訓練の手順・fixture・setup/teardownスクリプトは用意した（[`fault-injection-drill.md`](./fault-injection-drill.md)）が、「変更時に必ず訓練を実施すること」自体を機械的に強制する手段（例: 該当プロンプト変更を検知してブロックするpre-commit等）は無い。実施記録の記入漏れにも気づく仕組みが無い |
