// aidd-phase2.js の Spec Check フェーズが行っている「指定specPath以外のファイルを
// 誤って読んでいないか」の機械検証ロジックを、Node側の純粋関数として切り出したもの（issue #399）。
//
// 背景: Spec Checkエージェントに指定specPathとは異なるパス（例: リポジトリルート直下の
// 慣習的なSPEC.md）を読ませ、それをpassの根拠にしてしまう非対称バグが実測で確認された
// （根本原因はWorkflowツール側の可能性が高く、このリポジトリ側では修正できない）。
// 当面の防御として、エージェントに「実際にReadした絶対パス」を自己申告させ、
// 指定specPathとの一致をここで機械検証する。
//
// 注意（構造的な制約）: Workflow DSL（aidd-phase2.js）自体はrequire不可のため、
// このファイルの判定ロジックはaidd-phase2.js内にインライン複製されている。
// プロンプト文言・判定条件を変更した場合、このファイルとテストも手動で追従させること
// （自動では同期されない）。

// specCheck: Spec Checkエージェントの返り値 { status, detail, actualPath }
// specPath: 今回のAIDD実行に指定されたSPEC.mdのパス
//
// issue #548: 単純な endsWith(specPath) だと、'DRAFT-SPEC.md'.endsWith('SPEC.md') === true の
// ように「ファイル名の部分一致」まで「一致」として誤判定し、指定specPath以外のファイルを
// 読んだ非対称バグ（issue #399）への防御が最も必要な相対パス運用時にすり抜けていた
// （nodeで実行して実証済み）。一致箇所の直前がパス区切り('/')であることまで確認することで、
// ファイル名の部分一致を弾く。
// Workflow DSL側は`path`モジュールをrequireできないため、pathモジュールに頼らず文字列操作
// のみで判定できる形にしている（aidd-phase2.js内のインライン複製と同じ書き方に揃えるため）。
//
// 既知の限界: specPathが相対パスの場合、実際のリポジトリルートを知らないまま「末尾一致＋
// 直前がパス区切り」だけで判定するため、たまたま同じ相対サブパスを持つ別のサブツリー
// （例: specPath='docs/specs/SPEC.md'に対しactualPath='/repo/other/docs/specs/SPEC.md'）を
// 区別できない。この限界はspecPathを絶対パスで渡すことで解消される
// （呼び出し側規約として既に推奨されている。issue #507のコメント参照）。絶対パスの場合は
// 下のexact一致で判定が確定するため、この限界の影響を受けない。
export function isSpecCheckPathMismatch(specCheck, specPath) {
  if (specCheck?.status !== 'pass') return false
  if (typeof specCheck?.actualPath !== 'string') return false
  const actualPath = specCheck.actualPath
  if (actualPath === specPath) return false
  if (!actualPath.endsWith(specPath)) return true
  const boundaryChar = actualPath.charAt(actualPath.length - specPath.length - 1)
  return boundaryChar !== '/'
}
