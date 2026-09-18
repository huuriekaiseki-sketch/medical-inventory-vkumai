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
//
// ただし 2026-09-11 に、**プロンプト文言そのものの複製**は機械同期するようにした:
// 正本は .claude/workflows/lib/prompts/manifest-check.js、突合は
// .claude/workflows/lib/__tests__/manifest-check-prompt-sync.test.js（npm test で毎回）。
// それまでは Spec Check にだけ同期テストがあり、ここは「自動では同期されない」と書いたまま
// 放置されていた（docs/agents/check-design-pitfalls.md の C-047）。
// **この判定表（下の純粋関数）とプロンプトの一致は、いまも機械では見ていない**——
// 同期しているのは文言の 2 つの複製どうしであって、文言と判定表の意味ではない。

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

// issue R04: `git diff --name-only <baseCommit>` は**追跡されているファイルの差分しか出さない**。
// 新しく作ったファイルは追跡されていないので 1 件も出てこない。
// AIDD が作るものの中で最も高リスクな成果物——**新しい migration**——はまさにこれに当たり、
// changedFiles から丸ごと抜けていた。抜けると TRI/RISK 判定（router-risk）も
// 「高リスクパスが 1 件も無い」と読む（実測: 新しい supabase/migrations/*.sql が出てこない）。
//
// trackedDiff: `git diff --name-only <baseCommit>` の出力行
// untracked:   `git ls-files --others --exclude-standard` の出力行
// 戻り値: 空行を除き、重複を除き、並びを安定させた 1 つの一覧
export function mergeChangedFiles(trackedDiff, untracked) {
  const lines = [...(trackedDiff ?? []), ...(untracked ?? [])]
    .map(line => String(line).trim())
    .filter(line => line !== '')
  return [...new Set(lines)].sort()
}
