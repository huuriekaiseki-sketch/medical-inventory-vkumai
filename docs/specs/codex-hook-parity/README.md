# Codex の hook を Claude Code と同じ仕様に揃える（仕様書の索引）

- feature: `codex-hook-parity`
- baseCommit: `9d8bc552`
- 起点: 2026-09-29 の配布物レビュー（`aidd-codex` / `aidd-codex-vkumai` 0.1.3）
- 状態: **6 本とも 2026-09-29 に承認・実装・マージ済み（PR #858〜#863）。0.1.4 として配布済み**（PR #864、marketplace `0ccc415`）。配布した版での実機確認は `docs/plugin/codex/evidence/2026-09-29-release-0.1.4-verify.md`。下の表の「実装」欄は実装した時点の記録

## 目指す状態

**同じ操作をしたら、Claude Code でも Codex でも同じように止まり、同じように通る。**

ただし 1 点だけ、揃えられない違いがあります。

| | Claude Code | Codex |
| --- | --- | --- |
| 人に確認を求める（ask） | 確認の画面が出る | **出せない**（Codex が未対応）。代わりに一律で止める（deny） |

このため Codex では「確認すれば通せる操作」が「人が手で実行する操作」になります。これは既存の方針で、今回は変えません。

## 仕様書の一覧

| # | 仕様書 | 何が揃うか | 影響する側 | 重要度 | 実装と実機確認（Codex CLI 0.147.0、配布した 0.1.4） |
| --- | --- | --- | --- | --- | --- |
| 01 | [ファイルの直接編集を止める](01-apply-patch.md) | Codex のファイル編集でも守りが効く | Codex のみ | 高 | 済み（PR #858）。実機 ✅: 作る・変える・消す・移す・複数ファイル |
| 02 | [前置き付きのコマンドを止める](02-command-prefix.md) | `PGPASSWORD=… psql` などを止める | **両方** | 中 | 済み（PR #861）。実機 ✅: 代入・`sudo -u`・`env`・括弧・`bash -c`・`npm --prefix`。Claude Code 側は実機未確認 |
| 03 | [読むだけの操作を止めない](03-readonly-false-deny.md) | `cat` や `--version` を通す | **両方** | 低 | 済み（PR #862）。実機 ✅: `psql --version` と `cat` は止まらない。Claude Code 側は実機未確認 |
| 04 | [守りの部品が欠けたら止める側に倒す](04-wrapper-fail-closed.md) | 壊れた導入で素通りしない | Codex のみ | 低 | 済み（PR #860）。実機 ✅: 判定本体が無い場合。失敗・読めない結果の場合は未確認 |
| 05 | [警告だけの hook は失敗しない](05-stop-hook-never-fails.md) | 「hook が失敗しました」を出さない | Codex のみ | 低 | 済み（PR #859）。**実機 ⬜: 非対話モードでは確かめられない**（直す前の版でも失敗が見えない） |
| 06 | [警告文を導入先でも読める形にする](06-message-pointers.md) | 無い文書を指さない | **両方** | 低 | 済み（PR #863）。実機 ✅: 理由文 2 つと開始時の警告 2 本 |

件数: 6 本（Codex のみ 3 本、両方 3 本）。

**02・03・06 は Claude Code 側の動きも変わります。** 判定の本体を 2 つのツールで共有しているためで、片方だけ直すことはできません（共有しているから「同じ仕様」が保てています）。

## Claude Code 側にしかない hook（仕様書 07）

6 本とは別に、Claude Code 側にあって Codex 側に無い hook が **40 個**あります（2026-09-29 に全数を調べた。当初ここに書いていた「14 本」は、セッション開始時などを数えていない数字だった）。

| # | 仕様書 | 内容 | 状態 |
| --- | --- | --- | --- |
| 07 | [Claude Code 側にしかない hook を、Codex へ持っていく](07-claude-only-hooks.md) | 40 個を仕分け、持っていけるものを持っていく | 2026-09-30 承認（決めてほしいことは、おすすめの通り）。A の 12 個を実装済み。Codex の実機で発火を確認したが、**普段の作業場所では動かない**（リポジトリの `.codex/` が読み込まれない）。プラグインで配ることに決定（仕様書 08 で実装） |

| 区分 | 個数 | 扱い | 状態 |
| --- | --- | --- | --- |
| A: 登録するだけで動く | 12 | 持っていく | 実装済み（入口 `scripts/codex-session-start.sh`） |
| A': ローカル Supabase の自動停止 | 2 | 実機確認（人による信頼の操作が要る）の後に判断 | 未着手 |
| B: 作り直しが要る | 8 | 1 つずつ別の仕様書にする | 未着手 |
| C: 持っていかない | 18 | 対象が Claude Code 自身（7）、AIDD のワークフロー（10）、別の仕組みで足りている（1） | — |

仕様書を書いた時点では A が 13 個・B が 7 個でした。実装のときに測ると、「用済みの作業場所やブランチが溜まっている」の見張り（`check-stale-worktrees.sh`）は、知らせ済みの印をファイルに書き、初回は約 5 秒かかることが分かったので、A から B へ移しました。

どの hook をどの区分にしたかは `scripts/lib/codex-hook-gap.json` に 1 本ずつ書いてあり、`scripts/codex-hook-gap.test.sh` が実際の登録と突き合わせます。

## 進め方（AI 用）

### 実装の順番

同じファイルを触る仕様書があるため、全部を同時には進められません。

| 波 | 仕様書 | 触る正本 |
| --- | --- | --- |
| 1 | 01 | `scripts/check-skip-marker-write.sh` / `scripts/check-dependency-change.sh` と各テスト |
| 1 | 04 | `scripts/codex-skip-marker-deny.sh` / `scripts/codex-dependency-change-deny.sh` / `scripts/aidd-codex-doctor.sh` と各テスト |
| 1 | 05 | `scripts/codex-ai-check-track.sh` / `scripts/codex-ai-check-suggest.sh` / `scripts/codex-ai-check.test.sh` |
| 2 | 02 | `scripts/check-direct-ddl-execution.sh` / `scripts/check-dependency-change.sh` と各テスト |
| 3 | 03 | `scripts/check-skip-marker-write.sh` / `scripts/check-direct-ddl-execution.sh` と各テスト |
| 3 | 06 | `scripts/check-branch-pr-status.sh` / `scripts/check-branch-tool-ownership.sh` / `scripts/check-local-main-freshness.sh` |
| 統合 | 全部 | 06 のうち `scripts/check-dependency-change.sh` の文言、`docs/plugin/codex*/KNOWN-LIMITS.md`、`dist/plugins/`（生成物）、版上げ |

### 共通の決まり

- **`dist/plugins/` は生成物。** 直すのは `scripts/` の正本で、`bash scripts/build-plugin.sh` で作り直し、`--check` の一致を確認する
- **PR は仕様書ごとに分ける**（01 だけ先に出せる形にする）
- 版上げと配布は `docs/plugin/RELEASE.md` の手順に従う。6 本まとめて 1 回にするか、01 だけ先に配るかは人が決める
- 各テストは**直す前に赤くなること**を確認してから直す（2026-09-29 の実測がそのまま赤の入力になる）
- ルート判定は実装に入るとき `aidd-phase1-router` で行う
- 実機（Codex CLI）での確認は、個人設定の変更を伴うので**実行前に承認を取る**
