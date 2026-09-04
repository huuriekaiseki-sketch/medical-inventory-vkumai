---
name: e2e-runner
description: E2Eテストとスクリーンショットを生成・実行する。
  「E2Eを書いて」「画面の動作確認をして」のときに使う。
allowed-tools: Read, Write, Bash
---

1. 仕様書の📸マークと撮影ポイントを対応させる
2. Playwright でテストを生成し e2e/ に置く
3. ./screenshot.sh で全画面を撮影し screenshots/ に保存する
（screenshot.sh はこのスキルフォルダに同梱）

`<url>`にはローカルの`file://`パスも渡せる。実装前モック（後述）の撮影にも同じスクリプトを
使う（**静的なモックの場合**。新規スクリプト不要）。

## インタラクティブなモックの撮影（クリックで状態が変わる等）

見た目だけでなくJS/UXの挙動確認をしたい実装前モックは、`.dc.html`（Claude Design。
Claude Code専用のためCodexでは作成できない）に限らず、通常の静的HTML＋JSでも同じ考え方で
作れる。ページ内に`<iframe>`でsandbox表示している場合はページ全体の`screenshot.sh`では
クリック後の状態を撮れないため、同梱の`mock-capture.mjs`を使う:

```js
import { openMock } from './mock-capture.mjs'

const { frame, shoot, close } = await openMock('<モックhtmlの絶対パス>')
console.log(await shoot('mock-1-idle'))
await frame.getByText('削除', { exact: true }).click()
console.log(await shoot('mock-2-processing'))
await close()
```

`openMock()`は対象iframeの領域をクリップ撮影する`shoot(name)`を返す。iframeを使わない
（`<body>`直下に普通のHTML/JSで作った）モックなら`page.screenshot()`で直接撮っても良い。
複数iframeがある場合は`openMock(path, {artboardIndex: N})`で対象を明示し、撮った画像を
必ず目視確認する（対象と違う要素を撮ってしまっても気づかず進めてしまうことがある）。
