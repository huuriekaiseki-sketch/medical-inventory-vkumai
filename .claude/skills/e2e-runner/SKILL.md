---
name: e2e-runner
description: E2Eテストとスクリーンショットを生成・実行する。
  「E2Eを書いて」「画面の動作確認をして」のときに使う。
allowed-tools: Read, Write, Bash(npx playwright *), Bash(${CLAUDE_SKILL_DIR}/screenshot.sh *), Bash(node *)
---

1. 仕様書の📸マークと撮影ポイントを対応させる
2. Playwright でテストを生成し e2e/ に置く
3. ${CLAUDE_SKILL_DIR}/screenshot.sh <url> <name> で全画面を撮影し screenshots/ に保存する
（screenshot.sh はこのスキルフォルダに同梱。`${CLAUDE_SKILL_DIR}` は実行時にスキルフォルダの
絶対パスへ展開され、frontmatterの`allowed-tools`の許可ルールと同じ文字列になるため
確認プロンプトなしで実行できる）

`<url>`にはローカルの`file://`パスも渡せる。feature-specスキルでUI変更のモック（Claude Design
の`.dc.html`等）を実装前に撮影する用途にも同じスクリプトを使う（**静的モックの場合**。新規
スクリプト不要）。

## インタラクティブなモックの撮影（クリックで状態が変わる等）

Claude Designのartboardはsandboxed iframe内に描画されるため、`screenshot.sh`（ページ全体を
撮るだけ）ではクリック後の状態を撮れない。同梱の`mock-capture.mjs`を使う:

```js
import { openMock } from '${CLAUDE_SKILL_DIR}/mock-capture.mjs'

const { frame, shoot, close } = await openMock('<designスキルでシードしたhtmlの絶対パス>')
console.log(await shoot('mock-delete-flow-1-idle'))     // 初期状態
await frame.getByText('削除', { exact: true }).click()
console.log(await shoot('mock-delete-flow-2-processing')) // クリック後の状態
await close()
```

`openMock()`はiframeの領域を特定してクリップ撮影する`shoot(name)`を返す。クリック・待機の
組み立てはモックごとに異なるため、この短いスクリプトを都度書く（実装で使う必要は無く、
実装前モック撮影のためだけの使い捨てスクリプトでよい）。
