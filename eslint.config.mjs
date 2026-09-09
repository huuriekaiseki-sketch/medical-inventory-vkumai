import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // git worktrees used by parallel agents
    ".claude/worktrees/**",
    // プラグイン v1 の生成物（issue #420）。正本は .claude/ と scripts/ で、そちらが lint 対象
    "dist/**",
    // WHY(2026-09-08): `supabase start` が edge runtime の束ねた JS をここへ書き出す。
    //      .gitignore 済み（リポジトリには入らない）だが eslint は無視しないので、
    //      **ローカルスタックを起動した人だけ `npm run lint` が 154 件で落ちる**状態だった。
    //      自分たちが書いたコードではないうえ、消してもまた生成される。
    "supabase/.temp/**",
  ]),
  // WHY: issue #757 の 5（PII のログ流出）。サーバー側（API Route・データ層・proxy）のログは
  //      施設の外に出る場所で、PostgreSQL の DETAIL には行の中身（患者 ID 等）が入る。
  //      console.* を直接呼ぶ経路を機械的に禁止し、伏せてから出す src/lib/log-safe.ts だけを出口にする。
  //      テストは spy で console を使うので対象外。クライアント側（画面）はブラウザのコンソールなので対象外
  {
    files: ["src/lib/**/*.ts", "src/app/api/**/*.ts", "src/proxy.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["src/lib/log-safe.ts"],
    rules: { "no-console": "off" },
  },
  // WHY: issue #757 の 15（タイムゾーン）。toLocale*String は実行環境のタイムゾーンで整形するため、
  //      Vercel（UTC）でサーバー整形すると JST の日付が前日になる。日付の整形は
  //      src/lib/format-date.ts（Asia/Tokyo 固定）だけに置き、直接呼び出しを機械的に禁止する。
  //      数値の toLocaleString（価格の桁区切り）は対象外
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/format-date.ts", "**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]",
          message: "日付の整形は src/lib/format-date.ts の formatJst* を使う（Asia/Tokyo 固定。issue #757 の 15）",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleString'][callee.object.type='NewExpression'][callee.object.callee.name='Date']",
          message: "日付の整形は src/lib/format-date.ts の formatJst* を使う（Asia/Tokyo 固定。issue #757 の 15）",
        },
      ],
    },
  },
  // WHY: issue #757 の 20（入力検証）。「スキーマを読み込んでいるか」を検査しても、読み込んだ
  //      うえで使っていない route は捕まえられない。本文を読む方法を
  //      src/lib/validation/parse-body.ts の parseBody だけにし、request.json() の直接呼び出しを
  //      機械的に禁止する（ログを log-safe.ts に、日付整形を format-date.ts に寄せたのと同じ形）。
  //      移行が済んでいない route は scripts/lib/input-validation-baseline.json に載っており、
  //      1 本ずつ移す間だけ eslint-disable を付ける。一覧は減らすことしかできない
  {
    files: ["src/app/api/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.name='request']",
          message: "本文は src/lib/validation/parse-body.ts の parseBody(request, schema) で読む（issue #757 の 20）",
        },
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.name='req']",
          message: "本文は src/lib/validation/parse-body.ts の parseBody(request, schema) で読む（issue #757 の 20）",
        },
      ],
    },
  },
  {
    files: ["src/lib/validation/parse-body.ts", "src/lib/validation/parse-query.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  // WHY(2026-09-09、#757 の 20 の続き): 本文と同じことをクエリ文字列にもする。
  //      読む方法を src/lib/validation/parse-query.ts の parseQuery だけにし、
  //      `searchParams.get()` の直接呼び出しを禁止する。
  //      2026-09-09 に 13 route（30 か所）を全部移して 0 本にしたので、いま入れられる
  //      （借金が残っている状態で入れると eslint-disable が散るため、順番はこちらが後）。
  //
  // WHY(searchParams に触ること自体を禁止する・2026-09-09): 最初は `.get()` の呼び出しだけを
  //      止めたが、`parseKeyword(params)` のように **URLSearchParams を渡す共通ヘルパ**が残っており、
  //      そこから route が値を取り出す道が開いていた。同日中にそのヘルパも
  //      zod の形（`keywordQueryShape`）へ移したので、**触ること自体**を禁止できるようになった。
  //      これで「クエリを読む方法は parseQuery だけ」が書き方の上で成立する。
  //
  // WHY(コードだけを見る検査と対で使う): eslint は構文で見るので、たとえば動的な
  //      プロパティ参照（`req['nextUrl']`）までは追えない。そちらは
  //      scripts/check-query-validation-coverage.test.sh が文字列で見る（2 つで対になる）。
  {
    files: ["src/app/api/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.name='request']",
          message: "本文は src/lib/validation/parse-body.ts の parseBody(request, schema) で読む（issue #757 の 20）",
        },
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.name='req']",
          message: "本文は src/lib/validation/parse-body.ts の parseBody(request, schema) で読む（issue #757 の 20）",
        },
        {
          selector: "MemberExpression[property.name='searchParams']",
          message:
            "クエリ文字列は src/lib/validation/parse-query.ts の parseQuery(request, schema) で読む（issue #757 の 20）。searchParams を共通ヘルパへ渡すのも不可——形（shape）を渡してスキーマに混ぜる",
        },
      ],
    },
  },
]);

export default eslintConfig;
