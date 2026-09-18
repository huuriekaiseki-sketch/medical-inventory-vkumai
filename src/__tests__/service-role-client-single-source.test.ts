// WHY: issue #793。service_role クライアントの生成・キャッシュ・env 未設定時の初回警告は、
//      4 ファイルに同じ 12 行がコピペされていた。しかも警告を持っていたのは 1 ファイルだけで、
//      残り 3 つは **env が無いと黙って記録を落としていた**。
//
//      共有ヘルパー（src/lib/security/service-role-client.ts）へ一本化したが、
//      **「重複が本当に消えたか」は型検査では分からない**。tsc は 5 個目のコピペが増えても通る。
//      次に記録経路を足す人がコピペで済ませたら、また 1 ファイルだけ警告が無い状態に戻る。
//      だから「新しく生えていないこと」を機械で見る。
//
// 限界:
//   - 見るのは `src/lib/security/` の直下だけ。別ディレクトリに作られたら気づけない
//   - 文字列で判定するので、同じことを別の書き方（分割代入・動的 import 等）でされたら外れる
//   - 「クライアントを作っていること」自体は止めない。止めるのは**キャッシュ付きの取得口を
//     自前で持つこと**で、共有ヘルパーを使わない理由があるなら、この検査ごと見直す

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SECURITY_DIR = path.resolve(__dirname, '../lib/security')
const HELPER = 'service-role-client.ts'

function securityFiles(): string[] {
  return readdirSync(SECURITY_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
}

describe('service_role クライアントの取得口が 1 か所だけであること（issue #793）', () => {
  // WHY(C-044): 走査が空振りしていたら、違反ゼロは「無い」ではなく「見ていない」
  it('走査対象を拾えている（空振り防止）', () => {
    const files = securityFiles()
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files).toContain(HELPER)
  })

  it('キャッシュ変数（let cached）を自前で持つのは共有ヘルパーだけ', () => {
    const offenders = securityFiles().filter(f => {
      if (f === HELPER) return false
      return /\blet\s+cached\b/.test(readFileSync(path.join(SECURITY_DIR, f), 'utf8'))
    })
    expect(
      offenders,
      `共有ヘルパー以外がキャッシュを自前で持っています: ${offenders.join(', ')}\n` +
        `createServiceRoleClientAccessor(logKey) を使ってください（issue #793）`,
    ).toEqual([])
  })

  it('createClient を直接呼ぶのは共有ヘルパーだけ', () => {
    const offenders = securityFiles().filter(f => {
      if (f === HELPER) return false
      const src = readFileSync(path.join(SECURITY_DIR, f), 'utf8')
      return /from\s+'@supabase\/supabase-js'/.test(src)
    })
    expect(
      offenders,
      `共有ヘルパー以外が @supabase/supabase-js を直接読み込んでいます: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('共有ヘルパーを使う側は、それぞれ違う logKey を渡している', () => {
    // 同じ logKey を使い回すと、どの記録経路が死んだのか分からなくなる
    const keys: string[] = []
    for (const f of securityFiles()) {
      if (f === HELPER) continue
      const src = readFileSync(path.join(SECURITY_DIR, f), 'utf8')
      for (const m of src.matchAll(/createServiceRoleClientAccessor\(\s*'([^']+)'/g)) keys.push(m[1])
    }
    expect(keys.length).toBeGreaterThanOrEqual(4) // 4 経路が使っている
    expect(new Set(keys).size).toBe(keys.length)
  })
})
