/**
 * ロット検索入力の正規化（issue #803 SPEC Part 1 決定 3: 「前後の空白だけ落とす」を採用）
 *
 * WHY: 全角→半角・ハイフン除去などの本格的な表記ゆれ吸収（決定 3 の (c)）は、
 *      検索語だけでなく DB に保存済みの値も同じ規則で正規化しないと効かないため見送った
 *      （SPEC Part 1 の 3 行目参照）。UI（入力欄）と API（route のバリデーション前）の
 *      **両方**がこの関数を呼ぶことで、「どこで正規化したか」の食い違いを無くす。
 */
export function normalizeLotInput(input: string): string {
  return input.trim()
}
