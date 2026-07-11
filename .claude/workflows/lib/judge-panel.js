// Judge Panel（aidd-1-1-deep-task.js）の分岐判定ロジック。
// 旧実装は正規化した文字列の「完全一致」でkeyDecisionsの重複を判定していたが、
// 別々のLLM提案は意味が同じでも表現が異なることがほとんどのため、常に「分岐あり」
// と判定され、不要な採点パネル（3案×3観点=9エージェント）が起動されていた（issue #295）。
// LLM呼び出し無しで決定的にテストできるよう、文字bigram（2文字の並び）のJaccard類似度で
// 判定する。日本語は単語間にスペースが無いため、単語分割ではなく文字n-gramを使う。
// 制約: 語尾・助詞レベルの言い換え（表記ゆれ）は捉えられるが、「データ」↔「情報」のような
// 真の同義語言い換えまでは検出できない（それには埋め込み/LLM判定が必要でコスト増になるため
// 意図的にスコープ外とした。issue #295の「キーワード抽出＋部分一致等」の対応方針を採用）。
// aidd-1-1-deep-task.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

const DEFAULT_SIMILARITY_THRESHOLD = 0.5

function toBigrams(text) {
  const cleaned = String(text).replace(/\s+/g, '')
  const grams = new Set()
  if (cleaned.length < 2) {
    if (cleaned.length > 0) grams.add(cleaned)
    return grams
  }
  for (let i = 0; i <= cleaned.length - 2; i++) {
    grams.add(cleaned.slice(i, i + 2))
  }
  return grams
}

function jaccardSimilarity(a, b) {
  const setA = toBigrams(a)
  const setB = toBigrams(b)
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const gram of setA) {
    if (setB.has(gram)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

// validProposals: [{ keyDecisions: string[], ... }, ...]
// 戻り値: { divergenceRatio, hasDivergence }
// divergenceRatio: 全keyDecisionsのうち、既存クラスタと非類似（新規判断）だった割合
// hasDivergence: 採点パネルを起動するかどうか（提案が2件以上かつdivergenceRatio >= threshold）
export function computeDivergence(validProposals, threshold = DEFAULT_SIMILARITY_THRESHOLD) {
  const allDecisions = validProposals.flatMap(p => p.keyDecisions)
  if (allDecisions.length === 0) {
    return { divergenceRatio: 0, hasDivergence: false }
  }

  const clusterRepresentatives = []
  for (const decision of allDecisions) {
    const isDuplicate = clusterRepresentatives.some(rep => jaccardSimilarity(rep, decision) >= threshold)
    if (!isDuplicate) clusterRepresentatives.push(decision)
  }

  const divergenceRatio = clusterRepresentatives.length / allDecisions.length
  const hasDivergence = validProposals.length > 1 && divergenceRatio >= 0.5
  return { divergenceRatio, hasDivergence }
}
