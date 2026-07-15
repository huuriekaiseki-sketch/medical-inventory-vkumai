#!/usr/bin/env node
// eval-workflow-prompts.sh（Bash）からNode ESMモジュールのプロンプトビルド関数を呼ぶための
// 薄いCLIラッパー。Bash側は`.js`のESM/CJS判定に関わりたくないため、.mjs拡張子で明示的に
// ESMとして実行し、動的importでモジュールを読み込む(issue #391)。
import { pathToFileURL } from 'node:url'

const [, , modulePath, fnName, specPath] = process.argv

if (!modulePath || !fnName || specPath === undefined) {
  console.error('usage: build-eval-prompt.mjs <modulePath> <fnName> <specPath>')
  process.exit(1)
}

const mod = await import(pathToFileURL(modulePath).href)
const fn = mod[fnName]
if (typeof fn !== 'function') {
  console.error(`build-eval-prompt: ${fnName} is not exported by ${modulePath}`)
  process.exit(1)
}

process.stdout.write(fn(specPath))
