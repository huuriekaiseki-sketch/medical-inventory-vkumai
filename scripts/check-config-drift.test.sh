#!/usr/bin/env bash
# WHY: issue #757 の 35。設定ドリフト検知の回帰テスト。
#
#      この仕組みは「差分が無ければ黙る」ので、**壊れて黙っても誰も気づかない**
#      （docs/agents/check-design-pitfalls.md「不在で判定するのに出る側の対を置かない」）。
#      出る側（差分を作る）と出ない側（一致する）の両方を fixture で測る。
#
#      実 DB は要らない。再生器と比較器の判定だけを見る（実 DB との端から端までの突合は
#      bash scripts/check-config-drift.sh が担い、その結果は logs には残さず人が回す）。
#
# 実行: bash scripts/check-config-drift.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "=== scenario 0: 実行系が足りない ==="
  echo "  SKIP: node が無いので確認不能（合格にも違反にも数えない）"
  echo "ALL PASSED"
  exit 0
fi
if [ ! -f "$SCRIPT_DIR/lib/replay-grants.mjs" ]; then
  echo "=== scenario 0: この導入先に検査本体が無い ==="
  echo "  SKIP: replay-grants.mjs が無いので対象なし"
  echo "ALL PASSED"
  exit 0
fi

node --input-type=module -e '
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = process.argv[1]
const { replayGrants, parseArgTypes, normalizeArgType } = await import(path.join(root, "scripts/lib/replay-grants.mjs"))
const { compareGrants, comparePolicies } = await import(path.join(root, "scripts/lib/compare-config.mjs"))

let fail = 0
const ok = (m) => console.log(`  OK: ${m}`)
const ng = (m, d) => { console.log(`  NG: ${m}`); if (d) console.log(`      ${d}`); fail = 1 }
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : ng(m, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`))

const work = mkdtempSync(path.join(tmpdir(), "config-drift-"))
const mig = path.join(work, "migrations")
mkdirSync(mig, { recursive: true })
const put = (name, sql) => writeFileSync(path.join(mig, name), sql)

console.log("=== scenario 1: REVOKE は GRANT より後なら効く（順に再生している） ===")
put("0001.sql", "CREATE TABLE t1 (id int);\nGRANT ALL ON TABLE t1 TO authenticated;\n")
put("0002.sql", "REVOKE INSERT, UPDATE, DELETE ON TABLE t1 FROM authenticated;\n")
{
  const r = replayGrants(mig)
  const row = r.live.find((x) => x.object === "t1" && x.role === "authenticated")
  eq(row?.privileges, ["MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE"], "GRANT ALL のあとの REVOKE が効く")
  eq(r.unparsed, [], "読めない行が無い")
}

console.log("=== scenario 2: ALL は MAINTAIN まで展開する（REVOKE ALL で残りかすが出ない） ===")
put("0003.sql", "REVOKE ALL ON TABLE t1 FROM authenticated;\n")
{
  const r = replayGrants(mig)
  const row = r.live.find((x) => x.object === "t1" && x.role === "authenticated")
  eq(row, undefined, "REVOKE ALL で 1 権限も残らない")
}
rmSync(path.join(mig, "0003.sql"))

console.log("=== scenario 3: プラットフォーム既定は表が作られた時点で付く ===")
{
  const r = replayGrants(mig)
  const row = r.live.find((x) => x.object === "t1" && x.role === "anon")
  eq(row?.privileges, ["MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE"], "何も書かなくても anon に既定が付く")
}

console.log("=== scenario 4: 動的 DDL の GRANT を黙って飛ばさない（C-044） ===")
put("0004.sql", `CREATE FUNCTION f1(a UUID) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.proname IN ('"'"'f1'"'"')
  LOOP
    EXECUTE format('"'"'GRANT EXECUTE ON FUNCTION %s TO service_role'"'"', fn.sig);
  END LOOP;
END
$$;
`)
{
  const r = replayGrants(mig)
  const row = r.live.find((x) => x.object === "f1(uuid)" && x.role === "service_role")
  eq(row?.privileges, ["EXECUTE"], "DO ブロックの中の GRANT を拾う")
  eq(r.unparsed, [], "読めない行が無い")
}

console.log("=== scenario 5: 型の別名を正式名へ寄せる ===")
eq(normalizeArgType("TIMESTAMPTZ"), "timestamp with time zone", "TIMESTAMPTZ を寄せる")
eq(normalizeArgType("INT"), "integer", "INT を寄せる")
eq(parseArgTypes("p_a UUID, p_b TIMESTAMPTZ DEFAULT NULL"), ["uuid", "timestamp with time zone"], "引数名と DEFAULT を落とす")

console.log("=== scenario 6: 差分を検知する（RED 方向の自己検証） ===")
{
  const expected = [{ object: "t", role: "anon", privileges: ["SELECT"] }]
  const same = compareGrants(expected, [{ object: "t", role: "anon", privileges: ["SELECT"] }])
  eq([same.missing.length, same.extra.length, same.different.length], [0, 0, 0], "一致していれば 0 件（対照）")

  const extra = compareGrants(expected, [
    { object: "t", role: "anon", privileges: ["SELECT"] },
    { object: "audit_log", role: "anon", privileges: ["SELECT"] },
  ])
  eq(extra.extra.map((r) => r.object), ["audit_log"], "実環境にしか無い権限を名指しする")

  const missing = compareGrants(expected, [])
  eq(missing.missing.map((r) => r.object), ["t"], "期待にしか無い権限を名指しする")

  const diff = compareGrants(expected, [{ object: "t", role: "anon", privileges: ["SELECT", "INSERT"] }])
  eq(diff.different.length, 1, "権限の中身が違えば名指しする")

  const pol = comparePolicies([{ object: "t", name: "p1" }], [])
  eq(pol.missing.length, 1, "消えたポリシーを名指しする")
  const polExtra = comparePolicies([], [{ object: "t", name: "p9" }])
  eq(polExtra.extra.length, 1, "増えたポリシーを名指しする")
}

console.log("=== scenario 7: 読めない GRANT は黙って飛ばさない ===")
put("0005.sql", "GRANT SELECT (id) ON TABLE t1 TO anon;\n")
{
  const r = replayGrants(mig)
  if (r.unparsed.length === 1) ok("列単位の GRANT を読めない行として報告する")
  else ng("読めない行を黙って飛ばした", JSON.stringify(r.unparsed))
}

rmSync(work, { recursive: true, force: true })
if (fail !== 0) { console.log("FAILED"); process.exit(1) }
console.log("ALL PASSED")
' "$REPO_ROOT"
