// e2e/global-teardown.ts
//
// WHY(C-030、2026-09-09): 全 spec が終わったところで、
//      **走り出す前からあった行が消えていないか**を見る。
//      後片付けが自分の作った行以外を消していれば、ここで実行そのものが失敗する。
//      spec 側に足すのではなく teardown に置くのは、
//      **どの spec が犯人でも同じ 1 か所で捕まえたい**から（並列で走るので犯人は特定できない）。

import { verifyProtectedRows } from './fixture-guard'

async function globalTeardown() {
  await verifyProtectedRows()
}

export default globalTeardown
