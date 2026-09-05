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
]);

export default eslintConfig;
