# 既知の制約（7 項目の 7 の後半）

## 層の切り方（v1.0）

- Workflow 5 本と sweep 4 軸・implementer 系 3 体は `aidd-vkumai` にある。共通側だけ入れても AIDD の
  フロー（調査→仕様→実装）は動かない。Next.js + Supabase 以外のスタックで使うには、`aidd-vkumai` を
  ひな形に自分のアダプターを作る（v1.x で Workflow を共通側へ移す計画。`docs/specs/plugin-v1/SPEC.md`）
- `check-readonly-bash.sh`（読み取り専用ロールの Bash deny）はアダプター側。npm / npx の許可リストが
  スタック固有のため。共通側にするには許可リストの設定化が要る
- **層の表（`plugin-layout.json`）に載っていないものは黙って同梱されない。** 生成器は表を回るだけで、
  表に無い実体はその視界に存在しない（型は [`check-design-pitfalls.md`](../agents/check-design-pitfalls.md) の C-047）。
  両方向で突き合わせているのは **hook（生成器の中）・検査 `*.test.sh`（`check-plugin-check-coverage.test.sh`）・
  agent / skill / workflow（`check-plugin-asset-coverage.test.sh`、2026-09-11 に追加）・
  支援スクリプト（`check-support-script-coverage.test.sh`、2026-09-12 に追加）** の 4 系統。
  支援スクリプトは長らく門が無く、「配らない」と判断されたのか足し忘れなのか記録から区別できなかった
  ——**`checksNotDistributed` に当たる「配らないと決めた」表そのものが無かった**ため。
  2026-09-12 に `supportScriptsNotDistributed`（理由必須）と `supportScriptsUnclassified`
  （判断の保留。`unclassifiedMax` で件数を固定し、増やせないが減らせる）を新設した。
  **いま未分類が 25 件ある**——Codex 用 4 本を配るか・ドリルと計測を含めるか・個人設定の
  statusline をどう扱うかは製品の判断なので保留してある（理由は層の表の `_why_unresolved`）

## Claude Code の仕様による制約

- `.claude/rules/`（パス限定ルール）と CLAUDE.md は同梱できない。導入先が持つ（`templates/consumer/`）
- Workflow は導入先のファイルを読めない。固有語彙は `args.riskConfig` で**呼ぶ側が**渡す
- **Workflow の入れ子は 1 段まで。** 導入先が wrapper Workflow を置いて
  `aidd-vkumai:aidd-phase1-router` を呼ぶと、その router がさらに `aidd-phase1` を呼ぶので 2 段になり、
  エージェントを 1 体も起動しないまま
  「workflow() cannot be called from within a child workflow」で失敗する（2026-09-12 実測）。
  **入口はセッションから直接呼ぶ**。中心リポジトリは router を直接呼ぶので 1 段に収まり、
  この形にならない——**配布物の形でだけ壊れる**ので、連鎖を
  `scripts/check-workflow-nesting.test.sh` が門にしている（型は C-053、実例は E-085）
- `InstructionsLoaded` の出力は無視される。常時ロード量の上限判定は SessionStart の
  `check-claude-md-size.sh` が担う
- プラグイン同梱 subagent の frontmatter `hooks` / `permissionMode` / `mcpServers` は無視される

## 配った検査の回し方（2026-09-12）

- 導入先から検査を回す入口は `aidd-check.sh`（aidd-core の `bin/` に入り、Bash の PATH に
  足されるので裸の名前で呼ぶ。アダプター側は `scripts/aidd-check.sh`）。
  導入先のルートを `CLAUDE_PROJECT_DIR` で明示し、**導入先を見る検査だけ**を回す。
  `aidd-check.sh --list` で対象だけを出せる
- 各検査が「何を見るか」は `scripts/lib/check-scopes.json`（生成物）に入っている:
  `self` = 配っているスクリプト自身の単体テスト（回さない）/ `consumer` = 導入先だけを見る /
  `both` = 自己検証と実態の走査が同居
- **入口の報告は 5 値**（2026-09-12）: `見た` / `対象なし` / `確認不能` / `落ちた` / `実体なし`。
  以前は「合格 N」しか出さず、**対象が無いので何もしなかった**ものを合格に混ぜていた
  （実測では、導入先で回る検査のうち実際に相手を見たのは半分ほどで、残りは
  「持っていないので黙った」——なのに表示は「合格 N」だった）。
  `対象なし` と `確認不能` の一覧は毎回出るので、**何が守られていないか**が読める
- 判定の仕方: 検査が出力に「対象なし」を含めたとき、**空の木でもう一度回して出力を比べる**。
  変わらなければ本当に何も見ていない。変われば、この導入先の何かを見ている
  （印は場面ごとに出るのに分類は検査ごとなので、文言だけで数えると守りを過小に見せる）。
  `確認不能`（実行系が無い）は落ちたかどうかより**先に**見る——確かめられなかったものを
  違反に混ぜるのは、対象なしを合格に混ぜるより悪い
- **限界**: `対象なし` の**正しさは各検査の自己申告**。上の差分は「実態ありの木と空の木で
  出力が変わるか」しか見ないので、検査が誤って「対象なし」と言えばそのまま通る。
  2026-09-12 に 3 つの木（中心・導入先 2 つ）で測った結果、
  出力が実行ごとに変わって必ず `見た` へ倒れる検査は **0 本**、
  実態を見た結果が無言で空の木と区別できない検査も **0 本**
- **門**（`scripts/check-plugin-check-coverage.test.sh`、2026-09-12）:
  scenario 5 = 配る検査を**空の git リポジトリ**で 1 本ずつ回し、落ちるもの・
  「対象なし」と言わないものを落とす / 5b = 免除は腐るので「空の木で通るようになったのに
  載ったまま」の行を落とす（門を入れた初回の実行で、書いた本人の宣言 2 件がこれで落ちた） /
  5c = `PATH` を絞って実行系を隠した木で回し、落ちるもの・「確認不能」とも「対象なし」とも
  言わないものを落とす / 5d = `cd` で足元を変える本体が兄弟スクリプトを相対パスで
  呼んでいたら落とす。製品固有の前提が要る検査は `plugin-layout.json` の
  `emptyRepoExempt` へ**理由つき**で宣言する（いまは 0 件）
- **根はすべて導入先を向いている**（2026-09-12 実測）。入口が回す検査を全数調べ、
  `CLAUDE_PROJECT_DIR` を優先せずに自分の位置から走査の根を組むものは **0 本**だった。
  この製品の実データ（e2e・stryker・migrations の形・eval-fixtures）を要求する検査は
  `checksNotDistributed` へ理由つきで移してある。
  **ただしこれは実測であって門ではない**——新しく足した検査が同じ間違いをしても、
  5d（呼び先）と 5/5c（ふるまい）に引っかからない形なら気づけない

## 運用上の制約

- Codex には配布できない（プラグイン機構が無い）。`.codex/hooks.json` と `.codex/agents/*.toml` は
  導入先へ手コピー
- 中心リポジトリと同じ hook を settings.json とプラグインの両方で入れると二重に発火する。中心リポジトリ
  自身では生成物を読まない
- **実行系が無い環境では多くの hook が沈黙する。** 2026-09-11 に実測し直した数字は次のとおり
  （それまでは「hook 33 本のうち 18 本が node / python3 / npx」と書いていたが、
  **`jq` を数えておらず実態より狭かった**）:

  | 実行系 | 呼ぶ hook | 無いとどうなるか |
  | --- | --- | --- |
  | `jq` | **46 本**（ほぼ全部） | **黙って降りる側が大半** / 一部は拒否側へ倒れる / 数本は読み切れない |
  | `python3` | 20 本 | 同様に沈黙しうる |
  | `node` | 3 本 | 同上 |
  | `npx` | 4 本 | 同上 |

  （数え方: `.claude/settings.json` と `.codex/hooks.json` とプラグインの `hooks/hooks.json` を
  合わせた**実体 47 本**が母数。**Codex 側は配布対象外**だが、同じスクリプトを呼ぶので
  同じ実行系に依存する——片方だけ見ると「Codex では沈黙している」に気づけない）

  沈黙は**警告が出ないだけで、止まりはしない**。つまり導入先の人には「検知が入っている」ように
  しか見えない。**この状態を毎セッション知らせる hook を入れた**——
  `check-hook-dependencies.sh`（SessionStart）。走査の本体は `scripts/lib/aidd-doctor.mjs` で、
  何に依存するかは**スクリプトの実体から実測する**（宣言表を持たない。持つと実態とずれる）。
  数字は `node scripts/lib/aidd-doctor.mjs --verbose` でいつでも測り直せる。
- 個人環境のスクリプト（`~/write_aidd_stats.sh`・`~/.claude/pending_issues.jsonl`）は同梱しない。
  それらに依存する Stop hook（AIDD stats の記録漏れ検知）は導入先で該当スクリプトが無ければ沈黙する
- `gate-effectiveness-monthly-check.sh` 等の TS 補助スクリプトは node の `--experimental-strip-types`
  で動く。node 22 未満では失敗し、fail-open で沈黙する
- 共通 fixture による回帰テスト（7 項目の 5）は v1.0 では中心リポジトリの `scripts/*.test.sh` と vitest
  が担い、生成物に対しては `scripts/build-plugin.test.sh` の構造検査（決定性・名前空間・同梱閉包・禁止語）
  のみ。生成物を直接テストする仕組みは別リポジトリ化（配布形態 (a)）のときに作る

## Workflow 内エージェントからの進捗記録（v1.0 の穴）

- エージェント本文の `log-agent-progress.sh` 等は、プラグインの `bin/` が Bash ツールの PATH に足される
  ことを前提にしている。**メインセッションの Bash では PATH にあることを実測したが、Workflow 内の
  エージェント（agent()）の Bash からは見つからなかった**（2026-09-06、fault-injection の 4 実走すべてで
  「見つからず実行できない」と報告、`logs/agent-progress.jsonl` は生成されず）。結果、プラグイン経由では
  自己申告の進捗・観測ログが欠落し、gap 検査（Stop hook）が記録漏れとして警告する。hook 側の骨格記録
  （`subagent-skeleton.jsonl`）は残るため、起動・完了の事実は追える
- 対処候補（v1.x）: エージェント本文に絶対パスを埋め込むのは配置場所が導入先ごとに違うため不可。
  SessionStart hook が導入先の `logs/` 配下等に PATH 情報を書き、本文からそれを読む案、または
  Claude Code 側で Workflow エージェントの PATH にも `bin/` が入るかの仕様確認（docs 差分確認で追う）
- `derive-test-selection`（04 表の機械導出）は導入先の `.claude/workflows/lib/router-risk.js` を import する
  ため v1.0 では同梱しない。導入先が手コピーで持つ

## 未検証

- `check-skip-marker-write.sh`（ask 型）のプラグイン経由: `bypassPermissions` では ask が素通りし
  （設計どおり）、`default` では headless のため拒否された。ask ダイアログが出ることは対話セッションで
  未確認（中心リポジトリでは実機確認済み）
