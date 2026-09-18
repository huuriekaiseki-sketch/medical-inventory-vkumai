# SPEC: CSP を frame-ancestors だけの状態から nonce ベースへ広げる（issue #757 の 16 の残り）

証明フェーズ 2 本目。`docs/agents/harness-score.jsonl` に「止めた / 見逃した / 邪魔した」を記録する対象。

## Part 0: 何が問題か

現在の CSP は **`frame-ancestors 'none'` の 1 ディレクティブだけ**（`next.config.ts:14`）。
`script-src` も `default-src` も無いため、**XSS が入った場合に実行を制限する仕組みが無い**。
クリックジャッキングは防いでいるが、スクリプト実行は素通りする。患者情報を扱う製品としては薄い。

`next.config.ts` のコメントに既に意図が書かれている:

> CSP は frame-ancestors だけ: Next.js のインラインスクリプトは nonce 無しでは script-src を絞れず、
> 'unsafe-inline' 付きの CSP は防御にならない。nonce 対応（proxy でヘッダ生成）は別 PR

本 SPEC はその「別 PR」。

## Part 1: 調査で分かったこと（すべて 2026-09-18 の実測）

| # | 事実 | 根拠 | 設計への影響 |
| --- | --- | --- | --- |
| 1 | **全 44 ルートが動的（ƒ）。静的ルートは 0 件** | `npm run build` の出力に `○ (Static)` が 1 件も無い | **nonce 方式の最大の代償が既に払い済み。** Next.js のドキュメントが警告する「静的化・ISR・CDN キャッシュの喪失」は、この製品では失うものが無い |
| 2 | **53 ファイルがインライン `style={{...}}` 属性を使う** | `grep -rl "style={{" src/app src/components` | `style-src` を厳格化すると**UI が全壊する**。ここは緩める判断が要る（Part 2 の判断 A） |
| 3 | ブラウザが Supabase へ直接接続する | `src/lib/supabase/client.ts` の `createBrowserClient` | `connect-src` に Supabase の URL が要る。抜けるとログイン・全データ取得が死ぬ |
| 4 | フォントは `next/font/google` で自己ホスト | `src/app/layout.tsx`（Ubuntu / Oswald） | `font-src 'self'` で足りる。外部ドメインの許可は不要 |
| 5 | `proxy.ts` が既に全リクエストを通る | `src/proxy.ts:176` の matcher（`_next/static`・画像を除く全部） | nonce 生成の置き場として自然。matcher の追加変更は不要 |
| 6 | Next.js は CSP ヘッダから nonce を自動抽出し、フレームワークのスクリプトに付ける | `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` | 各タグへ手で nonce を付ける作業は不要 |

## Part 2: 設計の判断

### 判断 A: style-src をどうするか（**レビューしてほしい点 1**）

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A-1 | `style-src 'self' 'unsafe-inline'` | 53 ファイルがそのまま動く。`<style>` 注入は防げない。**採用案** |
| A-2 | `style-src 'self' 'nonce-X'` + `style-src-attr 'unsafe-inline'` | 属性は許し `<style>` 注入は防ぐ（厳密には上）。ただし `style-src-attr` を解さないブラウザは `style-src` に落ちて**UI が全壊**する |
| A-3 | 53 ファイルのインライン style を CSS へ移す | 最も強い。**本 PR の範囲を超える**（別 issue） |

**A-1 を採る。** 理由: 守りたいのは第一にスクリプト実行であり、style の注入は深刻度が一段低い。
A-2 はブラウザ差で画面が壊れる経路があり、医療現場で使う製品では受け入れにくい。A-3 は別 issue として起票する。

### 判断 B: CSP の置き場所

`next.config.ts` の `headers()` から CSP を**外し**、`proxy.ts` が唯一の出所にする。
両方に書くと二重定義になり、どちらが効いているか読めなくなる（`docs/agents/check-design-pitfalls.md` の
「唯一の入口」の型）。**残り 6 ヘッダは `next.config.ts` に据え置く**（nonce に依存しないため）。

### 判断 C: 適用するディレクティブ

```
default-src 'self';
script-src 'self' 'nonce-{nonce}' 'strict-dynamic'{dev: ' unsafe-eval'};
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self' {NEXT_PUBLIC_SUPABASE_URL};
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

`'unsafe-eval'` は開発時のみ（React が eval でデバッグ情報を作るため。ドキュメント記載）。

## Part 3: 受け入れ条件

- [ ] `proxy.ts` がリクエストごとに異なる nonce を生成し、`x-nonce` と `Content-Security-Policy` の両方に載せる
- [ ] `next.config.ts` の `securityHeaders` から `Content-Security-Policy` が消え、他の 6 ヘッダは変わらない
- [ ] **CSP が緩んだら落ちる検査**（`script-src` から `nonce-` が消える・`'unsafe-inline'` が script-src に入る・ディレクティブが減る、のそれぞれで赤になること。RED 方向を実測する）
- [ ] `connect-src` に Supabase の URL が入る（環境変数から組む。ハードコードしない）
- [ ] **E2E が全件通る**（80 件）。特にログイン・MFA・発注・返却の画面が壊れていないこと
- [ ] **ブラウザのコンソールに CSP violation が 1 件も出ない**ことを実測（E2E の console 監視か手動）
- [ ] nonce が**リクエストごとに変わる**ことを実測（同じ値が 2 回出ない）

## Part 4: 危険なところ

| リスク | 兆候 | 対処 |
| --- | --- | --- |
| **画面が真っ白／操作不能** | script がブロックされる | E2E 80 件で実測してからマージ。CSP violation をコンソールで確認 |
| **Supabase に繋がらない** | ログインできない、データが出ない | `connect-src` の実測。env が無い環境での組み立ても確認 |
| `'strict-dynamic'` で既存の script タグが落ちる | 一部機能だけ動かない | E2E で画面ごとに確認 |
| dev と本番で挙動が違う | 手元で緑・本番で赤 | `isDev` の分岐を明示し、本番相当（`npm run build` + start）でも 1 度測る |

**このセッションで既に 4 件「手元は緑・CI だけ赤」を踏んでいる**ので、手元の E2E だけを根拠にしない。

## Part 5: 対象外

- インライン style の CSS 化（判断 A-3）→ 別 issue
- CSP violation の report-uri / report-to による収集 → 本番の監視（#757 の 8）と一体。外部待ち
- SRI（`experimental.sri`）→ 全ルートが動的なので nonce で足りる。実験的機能を増やさない

## Part 6: 想定する変更ファイル

- `src/proxy.ts` — nonce 生成と CSP 組み立て
- `next.config.ts` — CSP を外す
- `src/__tests__/proxy.test.ts` — nonce・ディレクティブの単体テスト（RED 方向を含む）
- `src/__tests__/next-config-headers.test.ts` — CSP が消えたこと・他 6 ヘッダが残ることを固定
- `e2e/` — CSP violation の監視（既存 spec に足すか新設かは実装時に判断）
- `docs/agents/promise-catalog.md` — 新しい約束を作るなら 1 行
- `docs/agents/harness-score.jsonl` — 証明フェーズの記録
