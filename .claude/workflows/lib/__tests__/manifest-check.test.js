import { describe, it, expect } from 'vitest'
import { classifyManifestCheck, applyChangedFiles } from '../manifest-check.js'

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
    const manifest = { specHash: 'abc123', approval: { approvedBy: 'huuriekaiseki@gmail.com' } }
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
    const manifest = { approval: { approvedBy: 'huuriekaiseki@gmail.com', approvedAt: '2026-07-10T05:00:00+09:00' } }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('blocked')
    expect(result.detail).toContain('specHashが記録されていません')
  })

  it('manifest.specHashとactualSpecHashが一致すればpass', () => {
    const manifest = {
      specHash: 'abc123',
      approval: { approvedBy: 'huuriekaiseki@gmail.com', approvedAt: '2026-07-10T05:00:00+09:00' },
    }
    const result = classifyManifestCheck(manifest, 'abc123')
    expect(result.status).toBe('pass')
    expect(result.detail).toContain('specHash一致')
  })

  it('manifest.specHashとactualSpecHashが不一致ならblocked（レビュー承認後にSPEC.mdが変更された）', () => {
    const manifest = {
      specHash: 'abc123',
      approval: { approvedBy: 'huuriekaiseki@gmail.com', approvedAt: '2026-07-10T05:00:00+09:00' },
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
      approval: { approvedBy: 'huuriekaiseki@gmail.com', approvedAt: '2026-07-10T05:00:00+09:00' },
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
