import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildProjects,
  ISOLATED_PROJECT_NAME,
  ISOLATED_SPEC_PATTERN,
  MAIN_PROJECT_NAME,
} from '../../e2e/project-isolation'

// WHY: P-017 の攻撃 spec は「攻撃の前後で施設 A の行が 1 つも変わらない」を全行比較で判定する。
//      並列実行だと他 spec の書き込みを攻撃と誤検知するため、単独プロジェクトへ隔離してある。
//      隔離が黙って外れると「たまに落ちるので retry で通す」方向へ流れ、最後は本物の変更を
//      見逃す側へ倒れるので、隔離の形（分離・依存の向き・重複なし）を CI で固定する。

const e2eDir = path.join(process.cwd(), 'e2e')

describe('e2e の攻撃 spec 隔離（P-017 のフレーキー対策）', () => {
  const projects = buildProjects()
  const isolated = projects.find((p) => p.name === ISOLATED_PROJECT_NAME)
  const main = projects.find((p) => p.name === MAIN_PROJECT_NAME)

  it('攻撃 spec 専用プロジェクトと通常プロジェクトの 2 つだけを定義する', () => {
    expect(projects.map((p) => p.name)).toEqual([ISOLATED_PROJECT_NAME, MAIN_PROJECT_NAME])
  })

  it('通常プロジェクトは攻撃 spec の完走を待つ（= 攻撃中に誰も書き込まない）', () => {
    expect(main?.dependencies).toEqual([ISOLATED_PROJECT_NAME])
    // 逆向き（攻撃を最後に置く）にすると、無関係なテストが 1 件落ちた日に
    // Playwright が依存元を skip し、P-017 が黙って実行されなくなる
    expect(isolated?.dependencies ?? []).toEqual([])
  })

  it('攻撃 spec はどちらか一方のプロジェクトにだけ含まれる（二重実行・実行漏れが無い）', () => {
    expect(isolated?.testMatch).toEqual(ISOLATED_SPEC_PATTERN)
    expect(main?.testIgnore).toEqual(ISOLATED_SPEC_PATTERN)
  })

  it('隔離パターンは実在する spec に 1 件だけ一致する（パターンの腐敗検知）', () => {
    const specs = fs.readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'))
    const matched = specs.filter((f) => ISOLATED_SPEC_PATTERN.test(f))
    expect(matched).toEqual(['api-cross-facility-attack.spec.ts'])
    // 残りが 0 件だと「通常プロジェクトが空」= 隔離ではなく全体停止になっている
    expect(specs.length - matched.length).toBeGreaterThan(0)
  })

  it('playwright.config.ts はプロジェクト定義をこのモジュールから受け取る（定義の二重管理を防ぐ）', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'playwright.config.ts'), 'utf-8')
    expect(config).toContain("from './e2e/project-isolation'")
    expect(config).toContain('projects: buildProjects()')
  })
})
