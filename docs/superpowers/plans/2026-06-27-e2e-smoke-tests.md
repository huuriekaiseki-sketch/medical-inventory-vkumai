# E2E スモークテスト Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Playwright スモークテストを導入し、主要ページが開いてJSクラッシュしないことをPR時に自動検証する。

**Architecture:** Playwright の `webServer` オプションで `next dev` を自動起動し、7ページに対してナビゲーション成功・コンソールエラーなし・`<h1>` 存在を確認する。GitHub Actions の `pull_request` トリガーでCIに組み込む。

**Tech Stack:** `@playwright/test` 1.x、GitHub Actions (`ubuntu-latest`)

## Global Constraints

- ブラウザ: Chromium のみ
- テストディレクトリ: `./e2e`
- devサーバーポート: 3000
- Node.js: 24.x (CI も `node-version: '24'` を使う)
- Supabase env var は GitHub Secrets から注入（`NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY`）

---

### Task 1: Playwright インストールと設定

**Files:**
- Modify: `package.json`（`devDependencies` と `scripts` に追記）
- Create: `playwright.config.ts`

**Interfaces:**
- Produces: `npm run test:e2e` コマンド、`playwright.config.ts` の `webServer` 設定

- [ ] **Step 1: Playwright をインストールする**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

期待される出力: `added N packages`、`chromium` ブラウザがインストールされる

- [ ] **Step 2: `package.json` の `scripts` に追記する**

`package.json` の `"scripts"` に以下を追加：

```json
"test:e2e": "playwright test"
```

- [ ] **Step 3: `playwright.config.ts` を作成する**

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
```

- [ ] **Step 4: 設定が読み込まれることを確認する**

```bash
npx playwright test --list
```

期待される出力: テストファイルが見つからない旨のメッセージ（エラーではなく0件）

- [ ] **Step 5: コミットする**

```bash
git add package.json package-lock.json playwright.config.ts
git commit -m "chore: install Playwright and add config"
```

---

### Task 2: スモークテストを書く

**Files:**
- Create: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `playwright.config.ts` の `baseURL`（`http://localhost:3000`）
- Produces: `npm run test:e2e` で7ページのスモークテストが実行される

- [ ] **Step 1: `e2e/smoke.spec.ts` を作成する**

```typescript
import { test, expect } from '@playwright/test'

const pages = [
  { name: 'デバイス一覧', path: '/products' },
  { name: 'カテゴリ一覧', path: '/categories' },
  { name: '施設一覧', path: '/facilities' },
  { name: '販売店製品一覧', path: '/distributor-products' },
  { name: '病院価格一覧', path: '/hospital-prices' },
  { name: 'ニュース', path: '/news' },
  { name: 'その他', path: '/other' },
]

for (const { name, path } of pages) {
  test(`${name}（${path}）が開いてクラッシュしない`, async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto(path)
    await expect(page.locator('h1')).toBeVisible()
    expect(consoleErrors).toHaveLength(0)
  })
}
```

- [ ] **Step 2: テストを実行して全件パスを確認する**

```bash
npm run test:e2e
```

期待される出力:
```
Running 7 tests using 1 worker
  7 passed
```

失敗した場合はエラーメッセージを確認し、対象ページの `<h1>` タグの有無をブラウザで確認する。

- [ ] **Step 3: コミットする**

```bash
git add e2e/smoke.spec.ts
git commit -m "test: add E2E smoke tests for all main pages"
```

---

### Task 3: GitHub Actions CI を設定する

**Files:**
- Create: `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: `npm run test:e2e`（Task 1 で定義）
- Produces: PR時に自動でスモークテストが走るCI

- [ ] **Step 1: ワークフローディレクトリを作成する**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: `.github/workflows/e2e.yml` を作成する**

```yaml
name: E2E Smoke Tests

on:
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run E2E smoke tests
        run: npm run test:e2e
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
```

- [ ] **Step 3: コミットする**

```bash
git add .github/workflows/e2e.yml
git commit -m "ci: add GitHub Actions E2E smoke test workflow"
```

- [ ] **Step 4: GitHub Secrets を登録する（手動・一度だけ）**

GitHubリポジトリの **Settings → Secrets and variables → Actions → New repository secret** で以下を登録：

| シークレット名 | 値 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` の値 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.local` の `NEXT_PUBLIC_SUPABASE_ANON_KEY` の値 |

- [ ] **Step 5: PRを出して動作確認する**

適当なブランチを作ってPRを出し、GitHub Actions の Checks タブで E2E が緑になることを確認する。
