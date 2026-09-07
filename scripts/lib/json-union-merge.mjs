#!/usr/bin/env node
// JSON を「行」ではなく「構造」で 3 者マージする git のマージドライバ。
//
// WHY: 2026-09-07。GitHub 停止で並行ブランチが 40 本たまり、`scripts/lib/plugin-layout.json`
//      だけで 10 本が衝突した。中身は全部「別々のキーを足しただけ」で、同じキーを奪い合っては
//      いない。行単位のマージは、たまたま近い行に足しただけで衝突を報告してしまう。
//
//      `merge=union`（両方の行を残す）は JSON には使えない。行が並ぶだけで構文が壊れる。
//      そこで JSON として読み、**基準（共通の祖先）から見て、どちらが足したか・消したか**で
//      合成する。両側が同じキーを**別の値に**変えたときだけ、素直に衝突として報告する。
//
// 使い方（各 clone で 1 回。ドライバの定義は .gitattributes では配れない）:
//   git config merge.jsonunion.name "JSON を構造で 3 者マージする"
//   git config merge.jsonunion.driver "node scripts/lib/json-union-merge.mjs %O %A %B %P"
//   （bash scripts/setup-merge-drivers.sh が上の 2 行を実行する）
//
// 引数: %O=基準 %A=こちら側（結果もここへ書く） %B=向こう側 %P=元のパス
// 戻り値: 0=解決した / 1=衝突（git が通常の衝突として扱う）
//
// 見つけられること: キーの追加・削除の合成、同じキーを別の値に変えた衝突
// 見つけられないこと: 値が配列のときの「意味のある順序」。配列は
//   「重複を除いた連結」にするので、順序が意味を持つ配列には使わない
//   （このリポジトリで対象にしているのは層の表・登録簿のようなキー辞書だけ）。

import { readFileSync, writeFileSync } from 'node:fs'

const [basePath, oursPath, theirsPath, label = 'JSON'] = process.argv.slice(2)

function read(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`json-union-merge: ${p} を JSON として読めない: ${e.message}`)
    return null
  }
}

const base = read(basePath)
const ours = read(oursPath)
const theirs = read(theirsPath)

// どれか 1 つでも読めなければ、素直に衝突として返す（黙って片方を捨てない）
if (base === null || ours === null || theirs === null) process.exit(1)

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const conflicts = []

function merge(b, o, t, path) {
  if (same(o, t)) return o
  if (same(b, o)) return t // こちらは触っていない → 向こうの変更を採る
  if (same(b, t)) return o // 向こうは触っていない → こちらの変更を採る

  if (isObject(o) && isObject(t)) {
    const bb = isObject(b) ? b : {}
    const out = {}
    for (const key of new Set([...Object.keys(o), ...Object.keys(t)])) {
      const inO = key in o
      const inT = key in t
      const inB = key in bb
      if (inO && inT) {
        out[key] = merge(bb[key], o[key], t[key], `${path}.${key}`)
      } else if (inO) {
        // 向こうが消したのか、こちらが足したのか
        if (inB && same(bb[key], o[key])) continue // 向こうが消した
        out[key] = o[key]
      } else {
        if (inB && same(bb[key], t[key])) continue // こちらが消した
        out[key] = t[key]
      }
    }
    return out
  }

  if (Array.isArray(o) && Array.isArray(t)) {
    // 重複を除いた連結。順序が意味を持つ配列には使わない（冒頭の限界を参照）
    const seen = new Set()
    const out = []
    for (const v of [...o, ...t]) {
      const k = JSON.stringify(v)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
    return out
  }

  // 同じ場所を両側が別の値に変えた → 人が決める
  conflicts.push(path)
  return o
}

const merged = merge(base, ours, theirs, label)

if (conflicts.length > 0) {
  console.error(`json-union-merge: ${label}: 同じ項目を両側が別の値にしている:`)
  for (const c of conflicts) console.error(`  ${c}`)
  process.exit(1)
}

writeFileSync(oursPath, JSON.stringify(merged, null, 2) + '\n')
process.exit(0)
