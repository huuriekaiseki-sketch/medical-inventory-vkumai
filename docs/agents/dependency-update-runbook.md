# 依存の月次棚卸し（dependency update runbook）

npm 依存は Dependabot（`.github/dependabot.yml`、週次）が minor / patch の PR を作るが、**major は
誰かが判断しない限り open のまま古くなる**し、Dependabot が止まっていても気づかない。公式ドキュメント
差分の確認（[`upstream-docs-review.md`](./upstream-docs-review.md)）と同じ型で「次回実施予定日」を持ち、
SessionStart hook（`scripts/check-dependency-update-staleness.sh`）と `claude -p --maintenance`
（`scripts/maintenance-digest.sh`）が期限切れを警告する（issue #757 の 21）。

依存を**足す・変える**ときの規約（ask hook・引き継ぎメモ 00 欄・`npm ci`・ロック出所）は
[`common.md`「依存関係の変更ルール」](./common.md#依存関係の変更ルール2026-09-04) と
[`known-failure-patterns.md`「依存関係層」](./known-failure-patterns.md#依存関係層npm-サプライチェーン) が
正本で、本ファイルはその**定期の入口**。

## 次回実施予定日

2026-10-06（月 1 の目安。Next.js / React / Supabase の major が出たとき、`npm audit` が high 以上を
出したとき、Dependabot の PR が 5 件（上限）で止まっているときは予定日を待たず実施する。実施後に手動で
書き換える）

## 手順（30 分）

1. `npm outdated` を実行し、Current / Wanted / Latest を実施記録に貼る（`npm view <pkg> dist-tags` で
   Latest の表示ずれを確認する。2026-09-06 に jsdom で `outdated` が 29.1.1 を Latest と出したが
   `dist-tags.latest` は 30.0.1 だった）。
2. open の Dependabot PR（label `dependencies`）を見る。CI が緑の minor / patch はまとめて取り込む
   （PR ごとにマージ。`npm ci` で入れ直し、`@supabase/*` を含むなら `npm run test:integration`、
   `next` / `react` を含むなら `npm run build` と `npm run test:e2e` をローカルで回す）。
3. major は 1 つずつ「取り込む / 保留」を決め、保留の理由を実施記録に書く（破壊的変更の一覧・
   このリポジトリで使っている機能への影響・依存元）。取り込むときは依存 1 つにつき PR 1 本。
4. ロックを手で更新するときは **CI と同じ npm の版**で `npx -y npm@<CI 版> install --package-lock-only`
   を掛ける（known-failure-patterns「ロックファイルをローカルの npm で更新すると CI の npm と食い違う」）。
5. `npm audit --omit=dev --audit-level=high` が 0 件であることを確認する。
6. 「最後に確認した版」と「次回実施予定日」を更新する。

## 判断の目安

| 種類 | 扱い |
| --- | --- |
| patch / minor（Dependabot） | CI 緑ならまとめて取り込む。理由を書かなくてよい |
| major（Dependabot か手動） | 1 つずつ。破壊的変更を読み、影響が無いと言えるまで保留。保留の理由を実施記録に |
| セキュリティ（`npm audit` high 以上） | 予定日を待たず対応。dev 依存でも直す（2026-09-05 の #740 と同じ） |
| ピン留め（`^` 無し）の `next` / `react` / `@next/env` / `eslint-config-next` | セットで上げる。片方だけ上げない |

## 最後に確認した版

| 対象 | 版 | 確認日 |
| --- | --- | --- |
| next / eslint-config-next | 16.3.4（`@next/env` は 16.2.12。次回 16.3.4 に揃える） | 2026-09-06 |
| react / react-dom | 19.2.8 | 2026-09-06 |
| @supabase/supabase-js | 2.112.4（Wanted 2.115.0） | 2026-09-06 |
| @supabase/ssr | 0.12.5（Wanted 0.12.6） | 2026-09-06 |
| vitest | 4.1.11（Latest 5.0.0、major 保留） | 2026-09-06 |
| typescript | 5.9.3（Latest 7.0.2、major 保留） | 2026-09-06 |
| eslint | 9.39.4（Latest 10.10.0、major 保留） | 2026-09-06 |
| CI の npm | 11.19.0（setup-node の Environment details） | 2026-09-05 |

## 実施記録

### 2026-09-06（初回。GitHub 停止中のため PR は復旧後）

- `npm outdated`: 13 件。minor / patch 10 件（`@playwright/test` 1.63.0、`@supabase/ssr` 0.12.6、
  `@supabase/supabase-js` 2.115.0、`@testing-library/react` 16.3.3、`@testing-library/user-event`
  14.6.7、`@types/node` 26.4.1、`@types/react` 19.2.18、`@types/react-dom` 19.2.7、`eslint` 9.39.5、
  `@next/env` 16.3.4）は Dependabot の次回 PR に任せる。
- major 3 件は保留: `vitest` 5.0.0（`--outputFile.json` と reporter の挙動が変わる可能性。
  フレーキー検知 #757-14（PR #773）が JSON レポートに依存するため、移行時はその構造テスト
  check-flaky-tests.test.sh で確認）、`typescript` 7.0.2（Next.js 16.3 の対応を待つ）、`eslint` 10.10.0（`eslint-config-next`
  16.3.4 の peer 範囲を待つ）。
- `npm audit --omit=dev --audit-level=high`: 0 件（2026-09-05 の #740 以降変更なし）。
- Dependabot の open PR: GitHub 停止中で確認不能。復旧後に確認。
