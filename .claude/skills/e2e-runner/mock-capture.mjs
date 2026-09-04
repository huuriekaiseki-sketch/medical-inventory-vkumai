// インタラクティブなClaude Designモック(.dc.html)のartboardはsandboxed iframe内に
// 描画されるため、screenshot.sh（ページ全体をURLから撮るだけ）では状態遷移を撮れない。
// iframeの領域を特定してクリップ撮影するための最小ヘルパー。
// 静的モック（{{}}バインディング・tweak無し）はこれを使わずscreenshot.shで完結する。
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

export async function openMock(seededHtmlPath, { outDir = 'screenshots', viewport = { width: 1280, height: 900 }, artboardIndex = 0 } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport })
  await page.goto(`file://${path.resolve(seededHtmlPath)}`)

  // WHY: canvas.jsonで複数artboardを並べたキャンバスではiframeが複数存在し、
  //      DOM順は必ずしもartboards配列の順と一致しない。誤って違うartboardを掴んで
  //      撮影してしまった実例があるため、呼び出し側にartboardIndexを明示させ、
  //      shoot()の結果を必ず目視確認することを前提にする（iframeCountを返す）
  const iframeCount = await page.locator('iframe').count()
  const targetLocator = page.locator('iframe').nth(artboardIndex)
  const frame = page.frameLocator('iframe').nth(artboardIndex)
  const iframeHandle = await targetLocator.elementHandle()

  async function shoot(name) {
    // WHY: iframeのbounding boxは撮影のたびに再取得する。状態遷移でartboard自体の
    //      高さが変わるモックがあるため、初回に固定したboxを使い回すとズレる
    const box = await iframeHandle.boundingBox()
    const outPath = path.join(outDir, `${name}.png`)
    await page.screenshot({ path: outPath, clip: box })
    return outPath
  }

  async function close() {
    await browser.close()
  }

  return { page, frame, shoot, close, iframeCount }
}
