# Codex 用 AIDD プラグイン設計仕様（レビュー案・第3版）

作成日: 2026-09-26

状態: 設計レビュー待ち（第3版）。実装・インストール・実走検証は未実施。

## 改訂履歴

| 版 | 内容 |
| --- | --- |
| 第1版（46df16eb） | 初版 |
| 第2版 | Claude Code レビュー反映（`aidd-core` との関係・旧前提の改訂対象・戻り先表・二重発火・`PLUGIN_ROOT`） |
| 第3版（改2） | Codex 再レビュー反映。doctor から「実発火の有無」を外し手動実走に一本化（§3.2）。「クラウド認証」を「独自の認証機構は作らない・検証は既存の `gh` 認証」に言い換え（§1） |
| 第3版（改） | Codex 第3版レビュー反映。導入先の条件を固定（§1.3）。受け入れテストのブランチ方向を実装に合わせて訂正（§4）。「GitHub 接続は不要」を撤回し、`gh`・認証・検査用 PR・`python3` を前提と doctor の項目に追加（§3.2・§7） |
| 第3版 | Codex レビュー反映。**初版のゴールを「vkumai の project hook を置き換える」から「別の小さなリポジトリに、プラグインだけで同じ保護を再現する」に変更**（§1）。これにより project hook の削除条件（指摘2）が問題ごと消える。5 フェーズ・Manifest・戻り先・実行記録は後続仕様へ分離（§6）。移す hook を実物のスクリプトを読んで 1 本ずつ分類（§3）。パッケージは 3 つ（`aidd-core` / `aidd-vkumai` / `aidd-codex`）と明記し、Codex 側 hook の生成元を `.codex/hooks.json` に定める（§2）。`PLUGIN_DATA` は初版で使わない（§5） |

## 1. 目的と初版のゴール

医療在庫管理リポジトリ（vkumai）で育てた Codex 向けの hook を、他のリポジトリでも導入できる形にする。

**初版のゴール**: vkumai の `.codex/hooks.json` のうち製品固有の判定を含まない hook を `aidd-codex` プラグインに入れ、**§1.3 の条件を満たす vkumai ではない検証用リポジトリ**に個人 marketplace から導入したとき、その hook が信頼後に発火し、vkumai と同じ判定結果を返すこと。「導入先に依存しない」とは製品コード（Supabase・npm スクリプト名・拡張子）に依存しないという意味であり、Git remote や `gh` といった実行環境には依存する（§1.3）。

初版で**やらないこと**:

- vkumai の `.codex/hooks.json` からの hook 削除。vkumai は既に project hook で保護されており、置き換える動機が無い。個人プラグインは個人設定であり、別の利用者・別の環境には届かないため、リポジトリ側の保護を削るとその環境で保護が消える（第2版レビュー指摘2）。vkumai にプラグインを入れる場合は doctor が重複を警告するだけで、project hook を正とする。
- 5 フェーズ（調査→仕様→実装→統合→検証）の制御、Run Manifest、`blocked` の戻り先、実行記録、効果測定。これらは §6 の後続仕様へ移す。
- MCP、外部 DB、デプロイ。プラグイン独自の認証機構も作らない（検証で GitHub に触るときは、利用者の既存の `gh` 認証をそのまま使う。§1.3）。

成功は「プラグインが一覧に出る」では判定しない。§4 の受け入れ条件を満たしたときに判定する。

### 1.1 公式ドキュメントで確認した前提（2026-09-26）

[OpenAI プラグイン構成](https://developers.openai.com/plugins/build/plugins)より:

- プラグインに同梱できるのは skills・MCP サーバー・lifecycle hooks。
- 同梱 hook はインストール・有効化だけでは信頼されず、利用者が現在の hook 定義を確認・信頼するまで Codex はスキップする。
- プラグインの **hook コマンド**には環境変数 `PLUGIN_ROOT`（インストール先）と `PLUGIN_DATA`（書き込み領域）が渡る。スキルから呼ぶ CLI に渡るとは書かれていない。
- custom agent（`.codex/agents/*.toml`）を同梱できるという記載は無い。

旧仕様書の「Codex にはプラグイン機構が無い」は当時の制約として扱い、本設計の前提にはしない。その記述が残る箇所は §2.3 で改訂する。

### 1.3 検証用リポジトリの条件

§3 の 4 本はそれぞれ次の環境が無いと判定せずに終了するか、逆に常に警告する。初版の受け入れ（§4）は、この条件をすべて満たす検証用リポジトリで行う。満たさない環境での挙動は KNOWN-LIMITS に書く。

| 条件 | 必要とする hook | 無い場合の挙動（実装で確認） |
| --- | --- | --- |
| GitHub に remote があり、`gh` がインストール・認証済み | `check-branch-pr-status.sh` | `gh` が無ければ静かに exit 0（`check-branch-pr-status.sh:32`）。判定しない |
| マージ済み PR が 1 件以上あり、その head ブランチをローカルに残してある | `check-branch-pr-status.sh` | PR が無ければ警告が出る機会が無く、発火の確認ができない |
| `origin/main` が存在し、一度 `git fetch` 済み | `check-local-main-freshness.sh` | `FETCH_HEAD` が無いと常に「古い」扱いで警告する（`check-local-main-freshness.sh:58`）。発火はするが「同じ判定」の確認にならない |
| `python3` がある | `check-local-main-freshness.sh` | 無いと fetch の経過時間が取れず、`origin/main` との差分だけで判定する |
| `jq` がある | 4 本すべて | SessionStart 3 本は静かに exit 0、`codex-skip-marker-deny.sh` は exit 2 で止まる |
| `claude/*` 命名のブランチを作れる | `check-branch-tool-ownership.sh` | 命名規約を使わないリポジトリでは発火する機会が無い |
| （不要）Claude 側の資産 | `codex-skip-marker-deny.sh` | 判定はパス `.claude/.verify-state/*.skip` への書き込みかどうかだけを見るので、Claude 側が入っていなくても deny は出る。守る意味があるのは Claude 側の verify-claims を使うリポジトリだけ |

検証用リポジトリは、本仕様の実装段階 (4) で `gh repo create` を使って作る（非公開）。作った時点で上の条件を満たすよう、マージ済み PR を 1 件作ってから hook を試す。

### 1.2 既存の参照元

- `.codex/hooks.json`: 現在 vkumai で稼働している Codex の project hook（§3 の分類対象）。
- `scripts/lib/plugin-layout.json`: 各スクリプトの配布先の正本。
- `scripts/lib/build-plugin.mjs`: Claude 用プラグインの生成器。
- `docs/agents/parallel-agent-work.md`・`docs/agents/claude-codex-coexistence-template.md`: 共存規則。判定本体を共有しアダプターで出力契約を変換する原則 2・3。
- `docs/specs/plugin-v1/SPEC.md`: Claude Code 用プラグインの設計と検証経験。

## 2. パッケージと生成

### 2.1 3 つのパッケージ

| パッケージ | 対象ツール | 中身 | 状態 |
| --- | --- | --- | --- |
| `aidd-core` | Claude Code | ツール非依存の判定スクリプト・Claude 用 hook アダプター・共通スキル | 既存 |
| `aidd-vkumai` | Claude Code | vkumai 固有（Supabase DDL・`ai:check`・依存変更の判定など） | 既存 |
| `aidd-codex` | Codex | Codex 用 hook アダプターと、それが呼ぶ判定本体（`aidd-core` と同じ正本から生成） | **本仕様で新設** |

vkumai 固有の Codex hook 用パッケージ（`aidd-codex-vkumai` に相当するもの）は初版では作らない。固有のものは `.codex/hooks.json` に残す（§3）。

### 2.2 正本と生成元

- 正本はすべて中心リポジトリの `scripts/` と `plugin-layout.json`。`aidd-codex` に手で書くスクリプトは無い。
- 判定本体（例: `check-skip-marker-write.sh`）は `aidd-core` と `aidd-codex` の両方に同じ内容で入る。プラグインの hook から確実に参照できるのは `${PLUGIN_ROOT}` 配下だけで、他プラグインのファイルを参照できるという公式記載が無いため、共有ではなく同一正本からの複製とする。両方に入るファイルが一致することを生成検査で確かめる。
- `plugin-layout.json` の `hookScripts` 所属に `aidd-codex` を足せる形にする（現在は 1 ファイル 1 所属のため、「`aidd-core` かつ `aidd-codex`」を表せる値か別キーが要る。形は段階 (1) で決める）。
- **Codex 側 hook の生成元は `.codex/hooks.json`**。現在の `build-plugin.mjs` は `.claude/settings.json` の hooks から `$CLAUDE_PROJECT_DIR/scripts/X` 形式だけを読んで生成しており（`build-plugin.mjs:125` 付近）、Codex 用には別の経路を足す。変換規則は次のとおり:

| 生成元（`.codex/hooks.json`） | 生成先（`aidd-codex/hooks/hooks.json`） |
| --- | --- |
| `"$(git rev-parse --show-toplevel)"/scripts/X args` | `"${PLUGIN_ROOT}"/scripts/X args` |
| `X` の所属が `aidd-codex` でない項目 | 出力しない（project hook に残る） |

ラッパー（`codex-*-deny.sh`）は `SCRIPT_DIR` 相対で判定本体を探すので、判定本体を同じ `scripts/` に同梱すれば書き換え無しで動く。スクリプト内部で導入先リポジトリを参照する箇所は `git rev-parse --show-toplevel` を使っており、`PLUGIN_ROOT` と取り違えないことをテストで確かめる。

### 2.3 旧前提の改訂（段階 (1) に含める）

「Codex にはプラグイン機構が無い」を理由にした記述が残る箇所。実装の段階 (1) で、§1.1 の前提に基づいて改訂し、配布可否を判定し直す。

| 箇所 | 現在の記述 | 扱い |
| --- | --- | --- |
| `docs/specs/plugin-v1/SPEC.md:55` | Codex にはプラグイン機構が無いため配布対象外 | 過去の設計記録なので本文は残し、該当行に「2026-09-26 に前提が変わった。本仕様を参照」と注記 |
| `docs/plugin/KNOWN-LIMITS.md:78`（生成先 `dist/plugins/aidd-core/KNOWN-LIMITS.md:78`） | Codex には配布できない | 「Codex 向けは `aidd-codex` で配る。agent 定義は配れない」に改訂 |
| `scripts/lib/plugin-layout.json:539`（`codex-ai-check.test.sh` の除外理由） | Codex にはプラグイン機構が無いので配布対象外 | 理由を「vkumai 固有（§3）」に書き直す |
| `scripts/lib/plugin-layout.json:285` 付近（`_why_unresolved`）と `codex-*` の未決項目 | Codex 用 4 本を配るかは保留 | §3 の分類で決着させ、未決から外す |
| `scripts/lib/plugin-layout.json:320`（`codex-dependency-change-deny.sh`） | Codex は v1 の配布対象外 | 理由を「判定本体が `aidd-vkumai` 所属のため」に書き直す |

### 2.4 パッケージ構成

```text
aidd-codex/
  plugin.json                  # portable manifest
  hooks/hooks.json             # .codex/hooks.json から生成。${PLUGIN_ROOT}/scripts/ を呼ぶ
  scripts/                     # 正本から生成。アダプターと判定本体
  skills/aidd-doctor/SKILL.md  # doctor の起動方法と読み方（初版のスキルはこれだけ）
  tests/                       # 配布物単体・故障注入用 fixture
  COMPATIBILITY.md
  KNOWN-LIMITS.md
  CHANGELOG.md
```

## 3. 移す hook の分類

vkumai の `.codex/hooks.json` に登録されている hook を、スクリプト本体を読んで分類した。判定本体の所属は `plugin-layout.json` の `hookScripts` の現在値。

| イベント | project hook | 判定本体と所属 | 分類 | 初版で `aidd-codex` に入れるか |
| --- | --- | --- | --- | --- |
| SessionStart | `check-branch-pr-status.sh` | 自身が本体。`aidd-core` | 共通 | **入れる** |
| SessionStart | `check-branch-tool-ownership.sh codex` | 自身が本体。`aidd-core`。引数でツール名を受ける | 共通 | **入れる**（引数 `codex` ごと生成） |
| SessionStart | `check-local-main-freshness.sh` | 自身が本体。`aidd-core` | 共通 | **入れる** |
| PreToolUse | `codex-skip-marker-deny.sh` | `check-skip-marker-write.sh`（`aidd-core`）の ask→deny 変換。守る対象は Claude 側の `.claude/.verify-state/*.skip` | Codex 専用アダプター（本体は共通） | **入れる**。ただし守る対象が Claude 側の verify-claims の状態ファイルなので、導入先が Claude 側の `aidd-core` を使っていなければ何も守らない。KNOWN-LIMITS に明記する |
| PreToolUse | `codex-dependency-change-deny.sh` | `check-dependency-change.sh`（`aidd-vkumai`）の ask→deny 変換 | Codex 専用アダプター（本体は vkumai 固有） | 入れない。本体が `aidd-vkumai` 所属で、npm 前提の判定 |
| PreToolUse | `check-direct-ddl-execution.sh` | 自身が本体。`aidd-vkumai` | vkumai 固有（Supabase DDL） | 入れない |
| PostToolUse | `codex-ai-check-track.sh` | 自身が本体。所属未決。`npm run ai:check` 等のコマンド名と `.ts/.tsx/.sql` を固定（`codex-ai-check-track.sh:32`） | vkumai 固有 | 入れない。Claude 側の相方 `ai-check-suggest.sh` も `aidd-vkumai` 所属 |
| Stop | `codex-ai-check-suggest.sh` | 同上。状態ファイルは `.codex/.ai-check-suggest-state` | vkumai 固有 | 入れない |

初版で `aidd-codex` に入るのは **SessionStart 3 本 + `codex-skip-marker-deny.sh`（と判定本体 `check-skip-marker-write.sh`）の 4 本**。残りは `.codex/hooks.json` に残す。「入れない」4 本を将来共通化するなら、コマンド名・拡張子・状態ファイルの場所を導入先設定から読む形に直す別タスクになる。

### 3.1 重複の扱い

- 同じスクリプト名が導入先の `.codex/hooks.json` とプラグインの `hooks.json` の両方に登録されていたら、doctor が「二重発火」として警告する。止めない（どちらを消すかは人が決める）。
- vkumai 自身にプラグインを入れる場合、上の 4 本が二重になる。**vkumai では project hook を正とし、project hook は消さない**。プラグインは vkumai 以外の導入先で使う。

### 3.2 信頼状態の報告

プラグインの hook は利用者が信頼するまで動かない。doctor は次を別々に報告する: hook がプラグインに含まれているか／信頼されているか（読めなければ「不明」）／必要な実行系（`jq`・`git`・`gh` とその認証・`python3`）があるか／`origin/main` と `FETCH_HEAD` があるか。実行系が欠けている hook は「判定しない」と表示し、「保護済み」とは出さない。**実発火の有無は初版の doctor では報告しない**（§5 のとおり実行記録を持たないため読む対象が無い）。実発火は §4「クリーン環境」の手動実走で確認し、記録を持つようになる後続仕様（§6）で doctor の項目に加える。未信頼・未発火・不明を「保護済み」と表示しない。信頼状態をプログラムから読めない場合は、信頼確認を導入手順の必須ステップとして README に書く。

## 4. 検査と受け入れ条件

本仕様作成時には実行しない。実装時に受け入れる条件。

| 検査層 | 確認すること |
| --- | --- |
| 配布物 | `.codex/hooks.json` から生成した `hooks.json` に §3 の 4 本だけが入り、パスが `${PLUGIN_ROOT}` になっている。2 回生成して差分ゼロ。`aidd-core` と両方に入るファイルが一致 |
| 生成器 | `aidd-codex` 所属でない hook を出力しない。`$(git rev-parse --show-toplevel)` 以外の command 形式は fail |
| 判定本体 | `check-skip-marker-write.sh` と SessionStart 3 本の既存テストが、プラグイン内のパスから呼んでも通る。`REPO_ROOT` が `PLUGIN_ROOT` にならない |
| 故障注入 | `jq` を外すと `codex-skip-marker-deny.sh` が exit 2 で止まる（fail-closed）。SessionStart 3 本は静かに exit 0（warning-only の設計どおり）。`gh` を外すと `check-branch-pr-status.sh` が静かに exit 0 し、doctor がそれを「判定しない」と表示する |
| doctor | 二重登録で警告が出る。未信頼で「保護済み」と出ない |
| クリーン環境 | §1.3 の条件を満たす検証用リポジトリに個人 marketplace から導入し、hook を信頼した**前**は発火せず、**後**に発火する。4 本それぞれの発火を次で確かめる: (a) `.claude/.verify-state/x.skip` への書き込みが deny される、(b) Codex で `claude/*` ブランチを開くと「Claude Code 用のブランチ」と警告が出る（プラグインは `codex` 引数で呼ぶため、警告するのはこの方向。`check-branch-tool-ownership.sh:35`）、(c) マージ済み PR の head ブランチを開くと警告が出る、(d) `FETCH_HEAD` を 24 時間より古くする（または削除する）と警告が出る。(c)(d) は結果を vkumai 上で同じ操作をしたときの出力と突き合わせる |

「Codex でも利用可能」と報告する条件は、クリーン環境での実走を含む。未信頼・未発火・確認不能の範囲は未検証と表示する。プラグインを変更する PR は、対象コミットの必須 GitHub Actions がすべて `success` になってから統合する（vkumai は CI の失敗がマージを機械的に止めない設定のため、実物を確認する）。

## 5. 記録

初版の hook は既存の記録先（`check-branch-*` は標準出力の警告、`codex-skip-marker-deny.sh` は hook の出力 JSON）をそのまま使い、新しい記録は持たない。`PLUGIN_DATA` は hook コマンドにしか注入が明示されていないため、初版では使わない。実行記録・効果測定の設計は §6 の後続仕様で行い、そのときにスキル経由の CLI へのパス受け渡し方法も決める。

## 6. 後続仕様へ分離するもの

| 分離先 | 内容 | 前提 |
| --- | --- | --- |
| フェーズ制御仕様 | 5 フェーズ、Run Manifest、仕様ハッシュ、`confirm/blocked/fail/unknown` の戻り先、再開 | 初版の hook がクリーン環境で動いた後 |
| 記録・効果測定仕様 | `PLUGIN_DATA` 上のリポジトリ別保存、`harness-score` の分母、既存 `harness-score.jsonl` との互換、CLI へのパス受け渡し | 同上 |
| role 配布 | `.codex/agents/*.toml` の同梱可否（公式記載なし）。スキル参照 vs `generate-codex-agents.mjs` での導入先生成の実機比較 | 同上 |
| vkumai 固有 Codex hook の共通化 | `codex-ai-check-*`・`codex-dependency-change-deny.sh` をパラメータ化して配れるようにする | 導入先が 2 つ以上になってから |
| 複数リポジトリ導入 | 導入先の確定、サイクル測定 | 導入先が決まってから |

第2版はコミットしていないため Git 履歴には残っていない。後続仕様は本 §6 を起点に改めて設計する。

## 7. 実装順

(1) `plugin-layout.json` に `aidd-codex` 所属を表せる形を足し、§3 の 4 本を宣言。§2.3 の旧前提を改訂。
(2) `build-plugin.mjs` に `.codex/hooks.json` からの生成経路を足し、§4「配布物」「生成器」のテスト。
(3) doctor（重複警告・信頼状態・実行系）とスキル、KNOWN-LIMITS。
(4) クリーン環境で導入・信頼・実発火の確認。

各段階で対象・検査結果・残る未検証範囲を示す。段階 (1)〜(3) は GitHub への接続を要しない。段階 (4) は `check-branch-pr-status.sh` の実判定のために GitHub remote・`gh` の認証・検査用 PR を要する（§1.3）。Supabase、本番 DB、デプロイへの接続は全段階で不要。

## 8. 再レビューで確認したい論点

1. §3 の分類で、`codex-skip-marker-deny.sh` を「導入先が Claude 側を使っていなければ何も守らない」と注記したうえで入れる判断は妥当か。外して SessionStart 3 本だけにすべきか。
2. §2.2 の「判定本体を `aidd-core` と `aidd-codex` の両方に複製」は、`plugin-layout.json` の 1 ファイル 1 所属の現状にどう足すのがよいか（多値化 vs 別キー）。
3. §1 で vkumai 自身を導入先から外したことで、初版の実走確認がクリーン環境だけになる。vkumai での二重登録確認（doctor 警告）を段階 (4) に含めるべきか。
4. §6 の分離先の切り方で、後続仕様どうしの依存に無理はないか。
5. §1.3 で「対象を絞る」でなく「導入先の条件を固定する」を選んだ。`gh`・GitHub 依存を初版に残す判断は妥当か。

## 9. 未確定事項と限界

- `PLUGIN_ROOT` の実際の値・hook 実行時の作業ディレクトリ・プラグイン更新時の挙動は未実測。
- plugin 同梱 hook の信頼状態をプログラムから読めるかは未確認。読めなければ doctor は「不明」と表示する。
- `.codex/agents/*.toml` の同梱は公式記載が無い。初版では扱わない。
- 本仕様は設計提案であり、Codex での実利用可能性を実証したものではない。

## 参照した公式資料

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins) — パッケージ構成、個人 marketplace、plugin 同梱 hook と信頼条件、`PLUGIN_ROOT` / `PLUGIN_DATA`。
- [OpenAI: Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) — スキル、MCP、hook の役割。
