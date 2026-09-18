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
  // WHY(2 つあった同じ files のブロックを 1 つにした・2026-09-10): flat config では
  //      後から来たブロックの no-restricted-syntax が前のものを**丸ごと置き換える**ため、
  //      同じ files を持つブロックが 2 つあると先のほうは死んだ設定になる。
  //      「どちらが効いているか読まないと分からない」形は、そこに規則を足したときに
  //      静かに無効化される（実際、本文側の規則は下のブロックにも重複していた）。
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
        // WHY(名前で当てるのをやめた・2026-09-10、レビュー指摘 R10): 以前は
        //      `callee.object.name='request'` と `'req'` の 2 つだけを禁止していたので、
        //      **引数の名前を変えるだけ**（`export async function POST(httpRequest)`）で
        //      検査を外せた。名前で当てる検査は書き方を変えられると外れる。
        //      そこで向きを逆にする——`.json()` は原則すべて禁止し、
        //      **応答を作る側だけを明示的に許す**（知らない名前は落ちる＝deny-by-default）。
        //      応答の本文を読む必要が本当にある場合は理由付きの eslint-disable を付ける
        //      （印で逃げていないかは scripts/check-input-validation-coverage.test.sh が見る）。
        {
          selector:
            "CallExpression[callee.property.name='json']:not([callee.object.name='NextResponse']):not([callee.object.name='Response'])",
          message:
            "本文は src/lib/validation/parse-body.ts の parseBody(request, schema) で読む（issue #757 の 20）。引数名を変えても外れないよう、応答を作る NextResponse.json / Response.json 以外の .json() はすべて禁止している",
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
