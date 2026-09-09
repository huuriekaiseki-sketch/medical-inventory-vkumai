import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { classifyManifestCheck, applyChangedFiles, mergeChangedFiles } from '../manifest-check.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')

describe('classifyManifestCheck', () => {
  it('manifestがnull（.aidd/run-manifest.jsonが存在しない）ならblocked', () => {
    const result = classifyManifestCheck(null, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('Run Manifestが存在しません')
  })

  it('approval.approvedByが無ければblocked', () => {
    const manifest = { specHash: 'abc123', approval: { approvedAt: '2026-07-10T05:00:00+09:00' } }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('承認が記録されていません')
  })

  it('approval.approvedAtが無ければblocked', () => {
    const manifest = { specHash: 'abc123', approval: { approvedBy: 'example-reviewer@example.com' } }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('承認が記録されていません')
  })

  it('approval自体が無ければblocked', () => {
    const manifest = { specHash: 'abc123' }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('承認が記録されていません')
  })

  it('specHashが無ければblocked', () => {
    const manifest = { approval: { approvedBy: 'example-reviewer@example.com', approvedAt: '2026-07-10T05:00:00+09:00' } }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('specHashが記録されていません')
  })

  it('manifest.specHashとactualSpecHashが一致すればpass', () => {
    const manifest = {
      specHash: 'abc123',
      approval: { approvedBy: 'example-reviewer@example.com', approvedAt: '2026-07-10T05:00:00+09:00' },
    }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('pass')
    expect(result.detail).toContain('specHash一致')
  })

  it('manifest.specHashとactualSpecHashが不一致ならblocked（レビュー承認後にSPEC.mdが変更された）', () => {
    const manifest = {
      specHash: 'abc123',
      approval: { approvedBy: 'example-reviewer@example.com', approvedAt: '2026-07-10T05:00:00+09:00' },
    }
    const result = classifyManifestCheck(manifest, 'xyz789')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('specHash不一致')
    expect(result.detail).toContain('abc123')
    expect(result.detail).toContain('xyz789')
  })
})

describe('applyChangedFiles', () => {
  it('changedFilesフィールドのみを上書きし、他フィールドは変更しない', () => {
    const manifest = {
      specPath: 'SPEC.md',
      specHash: 'abc123',
      baseCommit: 'd1a7dbd',
      changedFiles: [],
      approval: { approvedBy: 'example-reviewer@example.com', approvedAt: '2026-07-10T05:00:00+09:00' },
    }
    const updated = applyChangedFiles(manifest, ['src/app/page.tsx', 'src/lib/foo.ts'])
    expect(updated.changedFiles).toEqual(['src/app/page.tsx', 'src/lib/foo.ts'])
    expect(updated.specPath).toBe('SPEC.md')
    expect(updated.specHash).toBe('abc123')
    expect(updated.baseCommit).toBe('d1a7dbd')
    expect(updated.approval).toEqual(manifest.approval)
  })

  it('元のmanifestオブジェクトを変更しない（イミュータブル）', () => {
    const manifest = { changedFiles: ['old.ts'] }
    applyChangedFiles(manifest, ['new.ts'])
    expect(manifest.changedFiles).toEqual(['old.ts'])
  })

  it('changedFilesが空配列でも上書きできる', () => {
    const manifest = { changedFiles: ['old.ts'] }
    const updated = applyChangedFiles(manifest, [])
    expect(updated.changedFiles).toEqual([])
  })
})

// issue R04: `git diff --name-only <baseCommit>` は追跡済みファイルの差分しか返さない。
// AIDD が新しく作る migration は未追跡なので、そこだけを見ると証跡から丸ごと抜ける。
describe('mergeChangedFiles(issue R04)', () => {
  it('追跡済みの差分と未追跡の新規ファイルを合わせる', () => {
    const tracked = ['src/lib/foo.ts', 'src/app/page.tsx']
    const untracked = ['supabase/migrations/20260910_new.sql']
    expect(mergeChangedFiles(tracked, untracked)).toEqual([
      'src/app/page.tsx',
      'src/lib/foo.ts',
      'supabase/migrations/20260910_new.sql',
    ])
  })

  it('新しい migration が未追跡でも一覧に入る（TRI/RISK 判定が高リスクを見落とさない）', () => {
    // 追跡済み差分だけを見る従来の形では、この一覧は空だった
    expect(mergeChangedFiles([], ['supabase/migrations/20260910_new.sql'])).toEqual([
      'supabase/migrations/20260910_new.sql',
    ])
  })

  it('両方に出るファイルを二重に数えない', () => {
    expect(mergeChangedFiles(['a.ts'], ['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts'])
  })

  it('空行や前後の空白を落とす（コマンド出力をそのまま渡せる）', () => {
    expect(mergeChangedFiles(['a.ts', '', '  b.ts  '], ['', 'c.ts'])).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('どちらも空・未指定なら空配列', () => {
    expect(mergeChangedFiles([], [])).toEqual([])
    expect(mergeChangedFiles(undefined, undefined)).toEqual([])
  })
})

// この lib は実行パスに配線されておらず、実際に動くのは aidd-phase2.js のプロンプト指示。
// 純粋関数だけを直しても実行パスは変わらないので（C-041 と同じ形）、
// プロンプト側が本当に未追跡ファイルを取りに行っているかをここで見る。
describe('changedFiles を更新するプロンプトが未追跡ファイルを取る(issue R04)', () => {
  const source = readFileSync(WORKFLOW_FILE, 'utf-8')

  it('未追跡ファイルを列挙するコマンドがプロンプトにある', () => {
    expect(source).toContain('git ls-files --others --exclude-standard')
  })

  it('changedFiles を更新する箇所すべてが未追跡ファイルを取っている', () => {
    // `changedFiles` を上書きする指示の回数と、未追跡を取る指示の回数が揃っていること。
    // 片方だけ増えると、その経路だけ新規ファイルが抜ける。
    const updates = source.match(/changedFiles フィールドをその一覧で上書き|changedFiles フィールドを上書き/g) ?? []
    const untracked = source.match(/git ls-files --others --exclude-standard/g) ?? []
    expect(updates.length).toBeGreaterThan(0)
    expect(untracked.length).toBe(updates.length)
  })
})
