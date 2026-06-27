# E2E スモークテスト設計

**日付:** 2026-06-27
**スコープ:** Playwright スモークテスト導入 + GitHub Actions CI 組み込み

---

## 背景・目的

ページが開けなくなるランタイムエラー（例：middleware追加後にAPIが401を返しページがクラッシュ）を、コードレビューやユニットテストでは検出できなかった。Playwright E2Eスモークテストを導入し、変更後に主要ページが正常に表示されることを自動検証する。

---

## スコープ

**対象：** スモークテスト（ページが開いてJSクラッシュしないことの確認）
**対象外：** フォーム操作・CRUD操作・認証フロー・DBの中身の検証

---

## テスト対象ページ

| ページ | パス |
|---|---|
| デバイス一覧 | `/products` |
| カテゴリ一覧 | `/categories` |
| 施設一覧 | `/facilities` |
| 販売店製品一覧 | `/distributor-products` |
| 病院価格一覧 | `/hospital-prices` |
| ニュース | `/news` |
| その他 | `/other` |

---

## 検証内容（各ページ共通）

1. ページが200で返る（ナビゲーション成功）
2. JavaScriptコンソールエラーが発生しない
3. `<h1>` タグが存在する（ページが最低限レンダリングされている）

---

## 構成

```
e2e/
  smoke.spec.ts          # スモークテスト本体
playwright.config.ts     # Playwright設定（webServer自動起動）
.github/
  workflows/
    e2e.yml              # PR時に自動実行
```

`package.json` に追加するスクリプト：
```json
"test:e2e": "playwright test"
```

---

## Playwright設定方針

- `webServer`: `next dev` を port 3000 で自動起動（既に起動済みの場合は再利用）
- `baseURL`: `http://localhost:3000`
- ブラウザ: Chromium のみ（スモークテストに十分）
- `testDir`: `./e2e`

---

## GitHub Actions（`.github/workflows/e2e.yml`）

- **トリガー:** `pull_request`（全ブランチ）
- **実行環境:** `ubuntu-latest`
- **手順:**
  1. checkout
  2. Node.js セットアップ（バージョンはpackage.jsonのenginesに合わせる）
  3. `npm ci`
  4. `npx playwright install --with-deps chromium`
  5. `npm run test:e2e`
- **env var:** `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY` をGitHub Secretsから注入

**注意:** GitHubリポジトリの Settings → Secrets and variables → Actions で2つのシークレットを手動登録する必要がある（一度だけ）。

---

## 将来的な拡張（スコープ外）

- 主要操作テスト（登録・編集・削除）の追加
- 複数ブラウザ対応
- ログイン機能実装後の認証フロー追加
