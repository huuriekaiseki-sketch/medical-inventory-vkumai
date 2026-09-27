# Codex manifest 切り分け実験の差分 — 2026-09-27

CLI 0.147.0 で hook が認識されない原因を調べた際、個人コピーだけを変更した実験1の差分を保存する。実験2・3・C' の条件と結果は [実証記録](2026-09-27-verify.md) に記載した。この文書の差分は `/private/tmp/aidd-codex-manifest-experiment/overlay.diff` と `root.diff` から転記した。生成器と配布物には適用していない。

## `.codex-plugin/plugin.json` の追加

```diff
--- /dev/null
+++ /Users/masanori/.codex/plugins/aidd-codex/.codex-plugin/plugin.json
@@ -0,0 +1,6 @@
+{
+  "name": "aidd-codex",
+  "version": "0.1.0",
+  "description": "中心リポジトリから生成した AIDD の Codex 用 hook と環境診断",
+  "hooks": "./hooks/hooks.json"
+}
```

## ルート `plugin.json` からの `extensions` 削除

```diff
--- /private/tmp/aidd-codex-manifest-experiment/plugin.before.json
+++ /Users/masanori/.codex/plugins/aidd-codex/plugin.json
@@ -2,10 +2,5 @@
   "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
   "name": "aidd-codex",
   "version": "0.1.0",
-  "description": "中心リポジトリから生成した AIDD の Codex 用 hook と環境診断",
-  "extensions": {
-    "com.openai": {
-      "hooks": "./hooks/hooks.json"
-    }
-  }
  "description": "中心リポジトリから生成した AIDD の Codex 用 hook と環境診断"
 }
```

この実験1では hook は認識されなかった。後の実験Cでは configured marketplace に置いたコピーからルート `plugin.json` を外すと4本が認識され、C' ではルート `plugin.json` を戻すだけで4本とも消えた。最終的な生成物は `.codex-plugin/plugin.json` のみを使う。
