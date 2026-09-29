# Codex の hook を Claude Code と同じ仕様に揃える（仕様書の索引）

- feature: `codex-hook-parity`
- baseCommit: `9d8bc552`
- 起点: 2026-09-29 の配布物レビュー（`aidd-codex` / `aidd-codex-vkumai` 0.1.3）
- 状態: **01 は 2026-09-29 に承認・実装済み（Codex CLI 0.147.0 の実機でも実測済み。PR #858）。02〜06 は停止①（仕様レビュー待ち）**で、承認されるまで実装しない

## 目指す状態

**同じ操作をしたら、Claude Code でも Codex でも同じように止まり、同じように通る。**

ただし 1 点だけ、揃えられない違いがあります。

| | Claude Code | Codex |
| --- | --- | --- |
| 人に確認を求める（ask） | 確認の画面が出る | **出せない**（Codex が未対応）。代わりに一律で止める（deny） |

このため Codex では「確認すれば通せる操作」が「人が手で実行する操作」になります。これは既存の方針で、今回は変えません。

## 仕様書の一覧

| # | 仕様書 | 何が揃うか | 影響する側 | 重要度 |
| --- | --- | --- | --- | --- |
| 01 | [ファイルの直接編集を止める](01-apply-patch.md) | Codex のファイル編集でも守りが効く | Codex のみ | 高 |
| 02 | [前置き付きのコマンドを止める](02-command-prefix.md) | `PGPASSWORD=… psql` などを止める | **両方** | 中 |
| 03 | [読むだけの操作を止めない](03-readonly-false-deny.md) | `cat` や `--version` を通す | **両方** | 低 |
| 04 | [守りの部品が欠けたら止める側に倒す](04-wrapper-fail-closed.md) | 壊れた導入で素通りしない | Codex のみ | 低 |
| 05 | [警告だけの hook は失敗しない](05-stop-hook-never-fails.md) | 「hook が失敗しました」を出さない | Codex のみ | 低 |
| 06 | [警告文を導入先でも読める形にする](06-message-pointers.md) | 無い文書を指さない | **両方** | 低 |

件数: 6 本（Codex のみ 3 本、両方 3 本）。

**02・03・06 は Claude Code 側の動きも変わります。** 判定の本体を 2 つのツールで共有しているためで、片方だけ直すことはできません（共有しているから「同じ仕様」が保てています）。

## 今回の対象外（揃えるかどうかは別途判断）

Claude Code 側にあって Codex 側に無い hook です。レビューで「壊れている」と分かったものではないので、今回の 6 本には入れていません。

| 種類 | Claude Code 側にだけあるもの |
| --- | --- |
| ツール実行の前後 | `check-run-manifest-presence.sh` / `check-readonly-bash.sh` / `mark-supabase-started.sh` / `record-test-failure.sh`（4 本） |
| ターン終了時 | `check-full-run-before-finish.sh` / `check-escape-ledger.sh` / `check-domain-decisions-suggest.sh` / `verify-claims.sh` / `gate-effectiveness-monthly-check.sh` / `check-gap-check-state.sh` / `check-aidd-stats-recorded.sh` / `check-aidd-phase-stats-recorded.sh` / `check-handoff-format.sh` / `check-find-av-precision-recorded.sh`（10 本） |
| セッション開始時 | 今回は未比較 |

「全部同じ」をここまで広げる場合は、6 本が終わってから別の仕様書にします。多くは Claude Code の transcript や AIDD ワークフローに依存しており、Codex へそのまま持っていけるかは**確認が必要**です。

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
