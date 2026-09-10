# case-1-missing-mapper-field（sweep-types）

埋め込んでいる欠陥: 層をまたぐ型不一致。`src/types/eval-fixture-recall.ts` の `EvalFixtureRecallItem` は
`internalNote` を宣言していないが、`src/lib/eval-fixture-recall/repository.ts` の `mapRow()` は
`internalNote` を含むオブジェクトを返している（DB 列は存在するが型定義に欠落）。TypeScript の
余剰プロパティチェックで型エラーになる箇所を `@ts-expect-error` で抑制している。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（理由は
`../../sweep-data/case-1-missing-auth-check/NOTES.md` と同じ。issue #731）。2026-09-05 の実走では
自己申告コメント付きのまま HIT したが、出力は「既知の意図的不一致（ベンチマーク用 fixture）」と
格下げされており、同日の別実行では MISS だった。

期待パスは 2 つ（`eval-fixture-recall/repository.ts` と `types/eval-fixture-recall.ts`）のいずれか。
層をまたぐ欠陥なので、エージェントが型定義側を指して「internalNote が型定義に無い」と報告しても
正しい検出。2026-09-05 の再実行で型定義側だけを指した報告が repository.ts 固定の期待パスに
一致せず MISS になったため、判定器を配列対応にした（`scripts/lib/judge-sweep-recall.py`）。

## ほかに何が捕まえるか: **tsc が落とす**（2026-09-10 実測）

同じ形のコードを `src/lib/` に置いて `npm run typecheck` を回したところ、**落ちた**:

```
TS2578: Unused '@ts-expect-error' directive.
TS2353: Object literal may only specify known properties, and
        'internalNote' does not exist in type 'ProbeItem'.
```

`@ts-expect-error` は `return {` の行に置いてあるが、TypeScript は**プロパティの行**で
エラーを出すので**抑制が効いていない**。
この fixture が型検査に引っかからないのは抑制のせいではなく、
**`scripts/eval-fixtures/` が tsconfig の対象外だから**である。

つまり **実コードでこの欠陥が入れば CI の typecheck が落とす。**
Sweep がこれを外しても実害は小さい——**この層に新しい機械の検査を足す必要は無い**。

（`@ts-expect-error` のコメントは「抑制しているつもり」に見えて紛らわしいが、
fixture の意図＝「Sweep が層をまたぐ食い違いを見つけられるか」は変わらないので残す。）
