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

2026-11-24（月 1 の目安。Next.js / React / Supabase の major が出たとき、`npm audit` が high 以上を
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
| next / eslint-config-next | 16.4.2（PR #916、2026-10-23。Latest 16.4.3。`@next/env` は 16.2.12 のまま。次回 next と一緒に揃える） | 2026-10-24 |
| react / react-dom | 19.2.8（Latest 19.3.1、minor。ピン留めの組なので next と同じ回で判断） | 2026-10-24 |
| @supabase/supabase-js | 2.112.4（Latest 2.118.0） | 2026-10-24 |
| @supabase/ssr | 0.12.5（Latest 0.12.7） | 2026-10-24 |
| vitest | 4.1.11（Latest 5.0.5、major 保留） | 2026-10-24 |
| typescript | 5.9.3（Latest 7.0.2、major 保留） | 2026-10-24 |
| eslint | 9.39.4（Latest 10.13.0、major 保留） | 2026-10-24 |
| CI の npm | 11.19.0（`package.json` の `engines`。2026-10-23 に lock を 11.6.2 で作って `npm ci` が落ちた実例あり） | 2026-10-23 |
| fast-check | 4.9.0（dev のみ。推移依存は `pure-rand` 8.4.2 だけ） | 2026-09-07 |

## 実施記録

### 2026-10-24（2 回目。期限 2026-10-06 から 18 日遅れ）

前提: 2026-10-23 に `next` の critical 3 件（#901、main の定期 audit が起票）を予定日を待たず
PR #916 で対応した（next / eslint-config-next 16.3.8 → 16.4.2）。そのとき**手元の npm 11.6.2 で
lock を更新したら `@emnapi/runtime` / `@emnapi/core` の項目が落ちて CI の `npm ci` が全ジョブで失敗**し、
`npx -y npm@11.19.0 install --package-lock-only` で作り直して通した（手順 4 の実例）。

- `npm outdated`（lock の固定版 → Latest、2026-10-24）。minor / patch 15 件:
  `@next/env` 16.2.12 → 16.4.3、`@playwright/test` 1.62.1 → 1.64.1、`@supabase/ssr` 0.12.5 → 0.12.7、
  `@supabase/supabase-js` 2.112.4 → 2.118.0、`@tailwindcss/postcss` / `tailwindcss` 4.3.3（最新）、
  `@testing-library/react` 16.3.2 → 16.3.3、`@testing-library/user-event` 14.6.1 → 14.6.8、
  `@types/node` 26.4.0 → 26.6.5、`@types/react` 19.2.17 → 19.3.0、`@types/react-dom` 19.2.5 → 19.3.0、
  `@vitejs/plugin-react` 6.1.1 → 6.1.2、`eslint` 9.39.4 → 9.39.5、`jsdom` 30.0.1 → 30.1.3
  （`outdated` は Latest を 29.1.1 と出すが `dist-tags.latest` は 30.1.3。前回と同じ表示ずれ）、
  `next` / `eslint-config-next` 16.4.2 → 16.4.3（patch）、`react` / `react-dom` 19.2.8 → 19.3.1（minor）、
  `zod` 4.5.4 → 4.6.7（minor、exact 固定）。
- major 3 件は保留のまま: `vitest` 5.0.5（理由は 2026-09-06 と同じ。フレーキー検知 #757-14 が JSON レポートに依存）、
  `typescript` 7.0.2（Next.js 16.4 の対応を待つ）、`eslint` 10.13.0（`eslint-config-next` 16.4.x の peer 範囲
  `>=9.0.0` は満たすが、`@typescript-eslint` 側の対応を待つ）。
- **Dependabot の open PR は 0 件で、最後の PR は 2026-09-02（#701、closed）。** 7 週間 PR が無いのに
  minor / patch が 15 件たまっているので、**止まっている可能性が高い**（GitHub は Dependabot の PR に
  90 日反応が無いと更新を自動停止する。#701 を閉じたのが最後の反応）。確認は Insights →
  Dependency graph → Dependabot（admin 権限。API はこの token では 403）。止まっていれば
  「minor / patch は Dependabot に任せる」前提が崩れるので、次回は手動でまとめて上げる。
- `npm audit --omit=dev --audit-level=high`: 0 件（2026-10-23、#916 後の手元と CI の両方）。dev 依存の
  high 8 件は #890 のまま。
- 今回は依存を上げない。`next` は前日に上げたばかりで、minor 15 件は Dependabot の状態を確かめてから
  まとめる（上げるときは `npx -y npm@11.19.0` で lock を作る）。

### 2026-09-07（追加 1 件: fast-check）

`fast-check@4.9.0` を `devDependencies` に追加した（#757-6 プロパティテスト。
使い方と限界は [`property-testing.md`](./property-testing.md)）。

- **用途**: 不変条件カタログ（I-010 / I-012 / I-020）の**境界**を乱数で測る。
  既存の統合テストは代表値 1〜2 点しか通しておらず、境界そのものを測っていなかった。
- **代替案**: 端の値を配列に並べて `it.each` で回す。依存は増えないが、
  その配列は書き手が「危なそう」と思った値なので生成元がテストと同じになる（台帳の独立性でいう「同源」）。
  失敗を最小の反例まで縮める（shrinking）も無い。実際、導入初回に `-5e-324` という
  自分では書かない値で反例が出たので、この差は実効があった。
- **権限 / 環境変数 / DB への影響**: なし。実行時コードには入らない。
  ネットワークもファイル書き込みもしない。テストが実 DB を叩くぶん所要時間は増える（1 性質 25 回）。
- **固定した版と出所**: `fast-check` 4.9.0 / MIT / github.com/dubzzz/fast-check、
  推移依存は `pure-rand` 8.4.2 / MIT / 同一作者。**この 2 つで閉じている**。
- **差分**: `package.json` +1 行、`package-lock.json` +41 行（2 パッケージ）。
- **`npm audit --omit=dev --audit-level=high`**: 0 件（dev のみなので本番依存は変わらない）。
- **`bash scripts/check-lockfile-integrity.test.sh`**: 718 項目すべて registry 由来・sha512。
- **ロールバック**: `npm uninstall fast-check` と
  `supabase/__tests__/integration/invariant-properties.integration.test.ts` の削除で戻せる。
  他のテスト・実行時コードはこの依存を参照していない。

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
