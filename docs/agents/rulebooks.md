# ルールブックの索引

**このファイルは生成物。手で編集しない。** 正本は `scripts/lib/catalog-registry.json` と
各ルールブックの本文で、`bash scripts/render-rulebook-index.sh` で作り直す。
最新かどうかは `scripts/check-catalogs.test.sh`（CI `hooks-test`）が検査する。

ルールブックは「守るべきことを 1 行 1 件で並べ、状態の語彙を固定し、機械が形を検査する表」。
新しく作るときは `bash scripts/new-rulebook.sh`（雛形と登録を同時に作り、その場で検査まで回す）。

| ID 帯 | ルールブック | 何を並べるか | 状態の語彙 |
| --- | --- | --- | --- |
| `I-xxx` | [不変条件カタログ（I-xxx）](invariant-catalog.md) | 業務データが「どの経路から書かれても」満たしていなければならない条件。守る場所は原則 DB | 実装済み / 計画 / 対象外 |
| `P-xxx` | [約束カタログ（AAA）](promise-catalog.md) | auth / RLS / 施設境界 / admin 境界 / AAL2 / RPC 契約の約束。守るテストの名前に ID を書いて双方向に突合する | 毎回 / 変更時 / 節目 / 一度きり |

（2 件）
