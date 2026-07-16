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
export function isSpecCheckPathMismatch(specCheck, specPath) {
  if (specCheck?.status !== 'pass') return false
  if (typeof specCheck?.actualPath !== 'string') return false
  return !specCheck.actualPath.endsWith(specPath)
}
