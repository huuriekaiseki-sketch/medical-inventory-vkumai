// aidd-phase2.js の Manifest Check フェーズ・integrator の changedFiles 更新指示（docs/agents/run-manifest.md）
// が実際に行っている判定・更新ロジックを、可能な範囲でNode側の純粋関数として切り出したもの（issue #316）。
//
// 注意（構造的な制約）: Workflow DSL（aidd-phase2.js）自体はfilesystem/Node.js APIアクセスが無いため、
// manifest.jsonの読み込み・specHashの再計算（shasum）・実際のpass/blocked判定は、この関数を呼ぶのではなく
// 現在もエージェントへの自然言語プロンプト指示（Read/Bashツール）として実行されている。
// このファイルはaidd-phase2.jsの実行パスには配線されておらず、プロンプトが表現しようとしている
// 判定テーブル・更新ロジックを「文書化かつテスト可能な形」で保持するためのものである。
// プロンプト文言（aidd-phase2.js内の該当箇所）を変更した場合、このファイルとテストも
// 手動で追従させる必要がある（自動では同期されない）。

// manifest: .aidd/run-manifest.json の内容（存在しなければnull）
// actualSpecHash: 現在のSPEC.md内容から再計算したsha256ハッシュ
export function classifyManifestCheck(manifest, actualSpecHash) {
  if (!manifest) {
    return { status: 'blocked', detail: 'Run Manifestが存在しません' }
  }
  if (!manifest.approval?.approvedBy || !manifest.approval?.approvedAt) {
    return { status: 'blocked', detail: '停止①の承認が記録されていません' }
  }
  if (!manifest.specHash) {
    return { status: 'blocked', detail: 'specHashが記録されていません' }
  }
  if (manifest.specHash !== actualSpecHash) {
    return {
      status: 'blocked',
      detail: `specHash不一致: レビュー承認後にSPEC.mdが変更された可能性があります（manifest=${manifest.specHash}, actual=${actualSpecHash}）`,
    }
  }
  return { status: 'pass', detail: 'specHash一致（承認後にSPEC.mdの変更なし）' }
}

// manifest: 更新対象のmanifestオブジェクト（変更しない）
// changedFiles: 今回のAIDD実行で変更されたファイルの相対パス一覧
// 戻り値: changedFilesのみを上書きした新しいmanifestオブジェクト（他フィールドは維持）
export function applyChangedFiles(manifest, changedFiles) {
  return { ...manifest, changedFiles: [...changedFiles] }
}
