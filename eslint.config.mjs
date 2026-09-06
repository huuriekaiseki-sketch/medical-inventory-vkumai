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
]);

export default eslintConfig;
