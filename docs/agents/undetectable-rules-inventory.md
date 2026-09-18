# 検知手段のないルールの棚卸し

[`common.md`](./common.md) から分離した参照ドキュメント（issue #542。`/doctor`実行結果を踏まえ、
参照頻度が低く常時ロードする必要のないブロックをcommon.mdから切り出す方針。issue #445の
path-scoped rules化とは異なり、特定パスに紐づかない内容のため別ファイル化＋ポインタ参照とした）。

本ファイルは「センサーが無い」ルールの棚卸し。「センサーはあるが、検知後の是正（アクチュエータ）
がwarning止まりか機械化されているか」の棚卸しは[`actuator-inventory.md`](./actuator-inventory.md)
（issue #578）を参照。「センサーも是正もあるが、人が意図して横を通れる経路」（緊急対応・Studio・
赤 check のマージ等）とその記録手段は [`human-bypass-inventory.md`](./human-bypass-inventory.md)
（issue #757 の 33）を参照。

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
| 停止①②以外で止まらず自律進行すること | ルートの`CLAUDE.md`「絶対ルール」 | **2026-09-12 に備考を埋めた**（それまで空欄のまま残っており、なぜ検知できないのかが誰にも分からない状態だった）。検知できない理由は「止まった」という事象が**痕跡を残さない**こと——エージェントが確認を求めて待つのは会話の中だけで、ファイルにもログにも残らない。逆向き（止まるべきところで止まったか）は停止①②が人の応答を必要とするので分かるが、**止まるべきでないところで止まったこと**は、後から見ると「そのターンで終わった」としか見えず、自律進行を中断したのか作業が完了したのかを区別できない。近いものとして `scripts/check-empty-session-report.sh` が「中身の無いセッションレポート」を拾うが、それは成果物の空を見ているだけで停止の有無ではない |
| gap check stateの記録（`record-gap-check-state.sh` before/expectedの呼び出し） | ルートの`CLAUDE.md`「gap check state 記録ルール」 | gap check本体の実行はissue #488でStop hookに機械化済み。ただしこの記録呼び出し自体の呼び忘れ検知は無い（Workflow DSLがfilesystem API不可のため自己申告依存が残る。AIDD statsのphase単位呼び出しと同型の限界だったが、そちらはissue #524で検知済みになった） |
| seed・スクリーンショットに実在施設名を使わない | [`common.md`](./common.md)「テスト環境・データ衛生ルール」 | per-edit層で部分検知（`.claude/security-patterns.json`の`possible_real_facility_name`、issue #440）。ただし`/plugin install security-guidance@claude-plugins-official`の実機有効性は未確認、かつスクリーンショット・issue添付・E2E失敗ログは検知対象外 |
| `aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際のfault injection訓練の実施自体 | [`common.md`](./common.md)「fault injection訓練の実施タイミング（issue #395）」 | **2026-09-11 に部分検知済み**（[`fault-injection-drill.md`](./fault-injection-drill.md)「## 訓練したゲートの版」と `scripts/lib/gate-prompt-hash.mjs`・`scripts/check-fault-injection-drill-staleness.sh`）。門の文言（Spec Check / Manifest Check のプロンプト）を数えて、**訓練した版と違えば SessionStart で警告する**。ファイル全体ではなく門の文言だけを見るので、`aidd-phase2.js` の無関係な変更では鳴らない（2026-09-10 の 164 行の変更でも文言は一字も動いていなかったと実測）。**残る未検知**: 警告を無視して進むことは止められない（warning-only）。文言と判定表（`lib/manifest-check.js`）の意味が合っているかは見ない。訓練を回したのに「## 訓練したゲートの版」を更新し忘れると、実際には回したのに鳴り続ける |
| 引き継ぎメモを**会話の中だけ**（セッション終了報告）で残す場合のフォーマット遵守 | [`common.md`](./common.md)「引き継ぎフォーマット」 | `scripts/check-handoff-format.sh`（issue #524）はPR本文経由（`gh pr create`/`gh pr edit`）のみを対象にすると明記されていた。**2026-09-11 に `docs/sessions/` 側を検知済み**（`scripts/check-session-handoff-format.test.sh`）——必須見出しと 04 表の 4 値・理由の有無を、**PR 本文の hook と同じ判定**（`scripts/lib/handoff-04-table.sh`）で見る。対象は 00〜05 形式が入った 2026-08-28 以降のファイル名の日付で切る（それ以前のメモを後から違反にするのは歴史の書き換えになるため）。**残る未検知**: 会話の中だけで終わるセッション終了報告は依然として見えない（ファイルに残らないものは機械で追えない）。実データに対する判定は 2026-09-11 時点で**未発動**（対象のメモがまだ 1 本も無い）——効くことは fixture で測っている |
| アーキテクチャレビューartifact（オフラインHTML等）の生成元commitの鮮度確認 | セッション運用（ドキュメント化された正式ルールではなく実務上の慣行） | 2026-07-27、detached HEADで32コミット遅れた状態を元にしたレビューを危うくそのまま信用しかけた実例あり。レビューartifactに生成時点のcommit hash・`origin/main`との乖離を機械的に埋め込みチェックする仕組みは無く、都度手動でファイル内容を再検証するしかない。**2026-09-11 に、コミットされる HTML に限って部分検知済み**（`scripts/check-committed-html-generated.test.sh`）——追跡中の HTML は生成物の見出し（元と生成器を名乗る）を持ち、名乗った元と生成器が実在し、生成器が `--check` を持たなければ落ちる。実例: どこからも参照されていない `docs/aidd-status.html`（2026-06-25 の姿・生成器なし）が 2.5 か月置かれていたので消した（2026-09-11 に削除済み）（消す前の姿で門を回すと、その 1 枚を名指しで止めることを実測）。**残る未検知**: コミットされないレビュー artifact（手元の HTML・公開したページ）の生成元 commit は依然として見えない。門が見るのは「最新かを確かめる口があるか」までで、その `--check` を誰かが回しているかは各生成物の検査の担当 |
| Claude CodeとCodexの同一worktree同時作業の禁止（プロセスレベル） | [`parallel-agent-work.md`](./parallel-agent-work.md) | ブランチ命名規約（codex/*・claude/*）と起動ツールの取り違えは`scripts/check-branch-tool-ownership.sh`（両ツールのSessionStart hook・warning-only）で部分検知済み。ただし「同じworktreeで両ツールのプロセスが同時に動いている」こと自体の機械検知は無い（Codexプロセスを確実に識別する手段が無いため）。命名規約に従わない一般ブランチ（feature/*等）ではこの部分検知も効かない |
| 新しい検査・仕組みを作る前に「間違えやすい型」（C-xxx）を読むこと | [`common.md`](./common.md)「検査を作る前に「型」を読む（2026-09-09）」 | **読んだかどうかは機械で確かめられない。** 表の側の品質（実例に日付がある・守るテストが自己言及でない・検知なしの型が限界に名指しされている）は `scripts/check-pitfall-rulebook.test.sh` が守るが、それは「表が腐らないこと」であって「作る前に読んだこと」ではない。すり抜けが出たときに `escaped-defects.md` の「関連ルールブック」列へ C-xxx を書く運用も自己申告のまま。型の一覧が実際に使われたかを測る手段は今のところ無い（PR 本文に ID が出るかを数えるのは、書けば通せるので検知にならない） |
| e2e の後片付けを「自分が作った行」だけに絞ること、および新しい spec を全体実行で 1 回回すこと | [`e2e-test-hygiene.md`](../../.claude/rules/e2e-test-hygiene.md) | 2026-09-09、`hospital-prices.spec.ts` が「施設 A の院内価格を全部消す」後片付けをしており、並列で走る `price-history.spec.ts` の価格履歴を削除の連鎖（`20260906000007`）ごと巻き添えにした実例あり。**単体実行では絶対に出ず、全体実行でだけ落ちる**ため、単体で緑にして終える運用だと素通りする。文字列で「広すぎる削除」を当てる検査は書き方を変えれば外れるので作っていない。構造で消すなら spec ごとに施設を分ける方向だが、フィクスチャ生成の作り直しになるため未着手。現状の唯一の検知は CI の e2e ジョブ（main への push 後）と `scripts/check-flaky-tests.sh` |
| Codex hook変更時の実機検証（Terminalから`codex` CLI起動での発火確認）の実施自体 | [`claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md)「実機検証手順」 | 自動テストはスクリプト単体の入出力のみ検証し、hookが実際に発火するかは実機でしか確認できない（riff-gear/cardiosearchの実測でshell test緑のままCodex側hookが無言死する構造を確認済み）。「検証してからpushする」ことを機械強制する手段は無い（fault injection訓練の実施義務と同型の限界）。**2026-09-11 に 2 つだけ部分検知済み**: (1) 登録された hook が**書いたそのパスにあり実行ビットが立っているか**（`scripts/codex-config-separation.test.sh` の scenario 9。診断器は名前で探すのでそこは見ていなかった）、(2) **配線が変わったのに実走ドリルをやり直していないか**（[`hook-live-drill.md`](./hook-live-drill.md)「## 実走した版」と `scripts/lib/hook-registry-hash.mjs`。Claude 側と Codex 側の登録をまとめて版にし、`scripts/maintenance-digest.sh` が突き合わせる）。**残る未検知**: 実機で本当に発火するかは依然として人が回すしかない。版は**配線だけ**を見るので、hook のロジックを書き換えても鳴らない（毎回鳴ると読まれなくなるため意図して外した。実測で確認）。2026-09-05 の実走は版を残していないので、そこから何が変わったかは遡れない |
