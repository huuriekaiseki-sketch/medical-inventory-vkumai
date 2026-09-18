import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '@playwright/test'

// WHY: issue #757 の 20（画面の質）。この製品は病院のスタッフが業務で毎日使う。
//      キーボードだけで操作する人、拡大表示の人、読み上げを使う人が「操作できない」状態は、
//      機能が無いのと同じ。目視の確認は再現しないので機械で測る。
//
// WHY(重大なものだけを止める): **serious / critical だけ**を失敗にする。
//      moderate / minor は数えて増加だけを止める。判定基準は WCAG 2.1 の A / AA。
//
// WHY(認証済みの画面を見る): 未認証だと /login しか見られない。業務で使うのはログイン後の
//      画面なので、既定の storageState（認証済み）でそのまま開く。
//
// WHY(既知の色を例外にする): 2026-09-07 の初回計測で 3 種類の配色が基準に届かないと分かった。
//      どれも**見た目が変わる判断**（ボタンの地色・本文の灰色の濃さ）なので、人が決めるまで
//      例外として置く。ただし「例外にした配色以外の違反」は今日から止まる。
//      内訳と直し方は docs/agents/a11y-baseline.md。

const pages = [
  { name: 'デバイス一覧', path: '/products' },
  { name: 'カテゴリ一覧', path: '/categories' },
  { name: '施設一覧', path: '/facilities' },
  { name: '販売店製品一覧', path: '/distributor-products' },
  { name: '病院価格一覧', path: '/hospital-prices' },
  { name: 'ニュース', path: '/news' },
  { name: 'その他', path: '/other' },
]

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/**
 * 人の判断待ちの配色（2026-09-07 実測）。**増やしてはいけない。**
 * 決着したらこの表から消す（消すと自動的に検査が厳しくなる）。
 */
const PENDING_CONTRAST: ReadonlyArray<{ fg: string; bg: string; ratio: string; why: string }> = [
  // 2026-09-08: 人が「3 つとも直す」と決めたので空にした。
  //   白文字 on #ff5f03 → 地色を #b03f00 へ（比 5.90）
  //   #6b7280 on #edeade → #4b5563 へ（比 6.27）
  //   #9ca3af on #ffffff → #6b7280 へ（比 4.83）
  // **空にしたので、同じ配色が戻ってきたら即座に失敗する。**
]

/**
 * ページ別の既知の**場所**の数。**増やしてはいけない**。
 *
 * WHY(2026-09-08 に「件数」から「場所の数」へ変えた): 以前は axe が返したノードを 1 件ずつ
 *      数えていたので、**一覧の行が増えるだけで数が増えた**。`/news` は 1 行につき 1 か所
 *      （日時の薄い灰色）を出すので、手元の DB に製品が増えるほど数が増え、基準 12 に対して
 *      20 になって落ちた（実測）。**コードは 1 行も変わっていない**。
 *      消せないデータが積み上がってテストが壊れる形は E-022 / E-023 と同じで、これが 3 回目。
 *      見たいのは「同じ配色が**新しい場所**に増えていないか」なので、
 *      配色 + タグ + class の署名で重複を潰し、行数に依存しない単位で数える。
 */
const PENDING_COUNT: Record<string, number> = {
  // 2026-09-08: 判断待ちを 3 つとも直したので全画面 0。
  // ここに行を足すのは「新しい判断待ちを作る」ことなので、人が決めるまでやらない。
}

function isPending(fg: unknown, bg: unknown): boolean {
  return PENDING_CONTRAST.some(
    (p) => p.fg === String(fg).toLowerCase() && p.bg === String(bg).toLowerCase()
  )
}

/**
 * 「同じ場所」を表す署名。位置・並び順・中の文字は無視し、配色と見た目の指定だけを見る。
 * 一覧の 20 行が同じ書き方なら 1 か所と数える。
 */
function pendingPlace(html: string | undefined, fg: unknown, bg: unknown): string {
  const el = html ?? ''
  const tag = /^<(\w+)/.exec(el)?.[1] ?? '?'
  const cls = /class="([^"]*)"/.exec(el)?.[1] ?? ''
  const style = /style="([^"]*)"/.exec(el)?.[1] ?? ''
  return `${String(fg)}/${String(bg)} ${tag}[${cls}][${style}]`
}

test.describe('画面の操作性（アクセシビリティ）', () => {
  for (const { name, path } of pages) {
    test(`${name}（${path}）に新しい serious / critical の違反が無い`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('networkidle')

      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      )

      // WHY: 「違反がある」だけでは直せない。axe が計算した実測値（前景・背景・比・必要な比）を
      //      そのまま出す。色の問題は目視で再現しづらく、数字が無いと堂々巡りになる
      const describe = (n: { html?: string; any?: Array<{ data?: unknown }> }) => {
        const data = (n.any?.[0]?.data ?? {}) as Record<string, unknown>
        const measured = Object.keys(data).length
          ? ` [前景 ${String(data.fgColor)} / 背景 ${String(data.bgColor)} / 比 ${String(data.contrastRatio)}（必要 ${String(data.expectedContrastRatio)}）]`
          : ''
        return `    ${n.html?.slice(0, 100) ?? ''}${measured}`
      }

      const pendingPlaces = new Set<string>()
      const unexpected: string[] = []
      for (const v of blocking) {
        for (const node of v.nodes) {
          const data = (node.any?.[0]?.data ?? {}) as Record<string, unknown>
          if (v.id === 'color-contrast' && isPending(data.fgColor, data.bgColor)) {
            pendingPlaces.add(pendingPlace(node.html, data.fgColor, data.bgColor))
            continue
          }
          unexpected.push(`${v.impact} ${v.id}: ${v.help}\n${describe(node)}`)
        }
      }

      expect(
        unexpected,
        `${path} に新しい重大な違反がある:\n  ${unexpected.join('\n  ')}`
      ).toEqual([])

      // 既知の配色でも「場所」が増えたら止める（同じ色を新しい書き方で増やさせない）
      const allowed = PENDING_COUNT[path] ?? 0
      expect(
        pendingPlaces.size,
        `${path} の既知の配色の場所が基準（${allowed}）より増えた。` +
          `docs/agents/a11y-baseline.md を見て直す\n  ${[...pendingPlaces].join('\n  ')}`
      ).toBeLessThanOrEqual(allowed)

      // moderate / minor は 0 を保つ（今日時点で 0 件）
      const lesser = results.violations.filter(
        (v) => v.impact === 'moderate' || v.impact === 'minor'
      )
      expect(
        lesser.map((v) => `${v.impact} ${v.id}`),
        `${path} に moderate / minor の違反が増えた`
      ).toEqual([])
    })
  }
})
