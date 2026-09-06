// e2e/project-isolation.ts
// WHY: P-017 の攻撃 spec（api-cross-facility-attack.spec.ts）は「攻撃の前後で施設 A の行が
//      1 つも変わらない」を service role で全行スナップショット比較して判定する。この判定は
//      「その間、施設 A に誰も書き込まない」ことを前提にしている。
//      ところが e2e は既定でファイル単位に並列実行されるため、同じ cross-facility フィクスチャの
//      施設 A に消耗品を作る consumable-orders.spec.ts が同時に走ると、他テストが作った行を
//      「攻撃でデータが変わった」と誤検知する（2026-09-07 に workers=5 で実測再現）。
//
//      そこで攻撃 spec を独立した Playwright プロジェクトに分け、他の全 spec を
//      `dependencies` でその後ろに並べる。Playwright は依存プロジェクトを完走させてから
//      依存元を開始するので、攻撃 spec は「他のテストが 1 つも走っていない時間帯」に単独で走る。
//      比較対象は全行のままなので、本物の変更（行の追加・更新・削除）は 1 つも見逃さない。
//
//      向きの選択（攻撃を先に置く / 後に置く）は PR 本文 01 と
//      docs/agents/decisions.md に理由を書いてある。要点は「Playwright は依存プロジェクトが
//      failed だと依存元を skip する」ため、攻撃 spec を後ろに置くと無関係なテストが 1 件でも
//      落ちた日に P-017 が黙って実行されなくなる、という点。

import type { PlaywrightTestConfig } from '@playwright/test'

/** 単独実行が必要な spec（並列の他テストによる書き込みを前提にできない spec） */
export const ISOLATED_SPEC_PATTERN = /api-cross-facility-attack\.spec\.ts$/

/** 攻撃 spec 専用プロジェクト名 */
export const ISOLATED_PROJECT_NAME = 'isolated-cross-facility-attack'

/** それ以外の e2e をまとめて並列実行するプロジェクト名（従来の名前を維持する） */
export const MAIN_PROJECT_NAME = 'chromium'

type Projects = NonNullable<PlaywrightTestConfig['projects']>

export function buildProjects(): Projects {
  return [
    {
      name: ISOLATED_PROJECT_NAME,
      testMatch: ISOLATED_SPEC_PATTERN,
      use: { browserName: 'chromium' },
    },
    {
      name: MAIN_PROJECT_NAME,
      testIgnore: ISOLATED_SPEC_PATTERN,
      use: { browserName: 'chromium' },
      // 攻撃 spec の完走を待ってから並列実行に入る（= 攻撃中は誰も施設 A に書き込まない）
      dependencies: [ISOLATED_PROJECT_NAME],
    },
  ]
}
