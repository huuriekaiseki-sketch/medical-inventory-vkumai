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
]);

export default eslintConfig;
