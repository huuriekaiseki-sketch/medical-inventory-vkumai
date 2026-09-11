// 標準出力へ**同期で**書く。
//
// WHY(2026-09-11 に実測): Node の `console.log` は **標準出力がパイプのとき非同期**になる。
//      直後に `process.exit()` を呼ぶと、**未書き込み分がそのまま捨てられる**。
//      ファイルへ書くときは同期なので全部出る——つまり
//      **手で確かめると正しく見えて、パイプで使ったときだけ黙って切れる**
//      （docs/agents/check-design-pitfalls.md の C-051）。
//
//      実測（1 行 ≒ 50 バイト）:
//        期待 100 行     → `process.exit()` 100     / `process.exitCode` 100
//        期待 1,000 行   → `process.exit()` 1,000   / `process.exitCode` 1,000
//        期待 10,000 行  → `process.exit()` **1,306** / `process.exitCode` 10,000
//        期待 100,000 行 → `process.exit()` **1,306** / `process.exitCode` 100,000
//      パイプバッファ（約 64KB）に収まるうちは起きないので、
//      **出力が育っていくにつれ、ある日から黙って切れる**。
//
// WHY(`process.exitCode` にせず同期書き込みにした): 途中で抜ける `process.exit()` が 73 箇所あり、
//      そこは「後続を走らせない」ことに意味がある。`process.exitCode` へ替えると制御フローを
//      変えることになり、**直しそのものが新しい穴になる**（今日それを 4 回やった）。
//      書き込みのほうを同期にすれば、制御フローは 1 文字も変わらない。
//
// 限界: `console.error`（標準エラー）は替えていない。stderr は Node では常に同期なので
//      同じ問題は起きない（パイプでも同期）。
import { writeSync } from 'node:fs'

/**
 * 1 行書き出す（`console.log(x)` の置き換え）。
 * EAGAIN（書き込み待ち）は再試行し、EPIPE（読み手が消えた）は黙って諦める。
 */
export function writeLine(value) {
  const text = typeof value === 'string' ? value : String(value)
  const buf = Buffer.from(text + '\n', 'utf8')
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset, buf.length - offset)
    } catch (e) {
      if (e.code === 'EAGAIN') continue
      // 読み手が先に消えた（`| head` など）。ここで投げると呼び出し側が死ぬので黙って終える
      if (e.code === 'EPIPE') return
      throw e
    }
  }
}
