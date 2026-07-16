# missing-spec シナリオ

このディレクトリにはfixtureファイル（`SPEC.md`）を意図的に**用意しない**。

`scripts/aidd-fault-injection-setup.sh missing-spec` は、実在しないダミーパス
（例: `.claude/workflows/__fixtures__/fault-injection/missing-spec/SPEC.md`）を
`specPath`として標準出力に出すだけであり、実際のファイルは存在しない状態のまま
Workflow呼び出しに使う。

これにより、`aidd-phase2.js`の Spec Check が「指定された`specPath`のファイルが
存在しない」ケースを実際に検出し、`blockedAt === 'Spec Check'`を返すことを確認する。

参照: [`docs/agents/fault-injection-drill.md`](../../../../../docs/agents/fault-injection-drill.md)
