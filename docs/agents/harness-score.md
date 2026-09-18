# ハーネスの成績（harness-score）

**製品 issue 1 本ごとに、ハーネスの部品が「止めた / 見逃した / 邪魔した」を 1 件 1 行で残す。**
v1.x で何を残し・直し・削るかは、この記録を**層で分けて**読んで決める（2026-09-14 にユーザーが決めた方針。
「効いているものは残し、効いていないものは削る」）。

- 記録: [`harness-score.jsonl`](./harness-score.jsonl)（1 行 1 件の JSON。**git で追跡する**。`logs/` は機械ローカルで
  リポジトリをまたいで集められないため使わない）
- エンジン: `scripts/lib/check-harness-score.mjs`（形・語彙・参照先の実在を見る。`--summary` で部品 × 層の表と仕分けを出す）
- 守るテスト: `scripts/lib/__tests__/harness-score.test.ts`（`npm test` で毎回。RED 方向あり）
- エンジンは共通側（aidd-core）へ配る。**記録は各リポジトリのもの**（逆流しない。導入先の行はその導入先に残る）

## 1 行の形

```json
{"date":"2026-09-13","repo":"vkumai","issue":"#757-24 proxy_admin","component":"Coverage Check","layer":"core","verdict":"stopped","detail":"6 セット中 5 セット未実装を名指しし、統合担当が拾った","cost":{"minutes":1},"ref":"docs/sessions/2026-09-13-record-proxy-admin-denial.md"}
```

| 項目 | 必須 | 語彙・形 |
| --- | --- | --- |
| `date` | 必須 | `YYYY-MM-DD` |
| `repo` | 必須 | リポジトリ名（`vkumai` / `riff-gear` …）。集めたときにどこの行か分かるため |
| `issue` | 必須 | issue の番号か短い名前 |
| `component` | 必須 | 部品名（`Coverage Check` / `4 観点レビュー` / `E2E` / hook 名 / `深掘り Phase 1` など）。**同じ部品は同じ名前で書く**（別名は別の部品として数える） |
| `layer` | 必須 | `core`（共通側 aidd-core）/ `adapter`（vkumai アダプター）/ `consumer`（導入先固有。その導入先の設定・環境・自前 hook） |
| `verdict` | 必須 | `stopped`（止めた: 赤にして直させた）/ `missed`（見逃した: 通したが後で穴が出た）/ `obstructed`（邪魔した: 誤警告・空振り・待ち時間・空回り） |
| `detail` | 必須 | 何を止めた・見逃した・邪魔したか、1 文 |
| `cost` | 任意 | `{minutes, tokens, agents, usd}` の 0 以上の数。`obstructed` の重さはここでしか読めない |
| `ref` | 必須 | 根拠の置き場（リポジトリ相対パス。実在を検査する。`#見出し` を付けてよい） |

## 書き方

- issue を閉じるとき（PR 本文か docs/sessions を書くとき）に、その issue で起きた行を**全部**足す。
  「何も起きなかった部品」は書かない（行が無いことは「測っていない」であって「効かなかった」ではない）。
- `layer` は**部品がどこから来たか**で決める。同じ警告でも、共通側の hook なら `core`、導入先が自前で置いた hook なら `consumer`。
  ここを間違えると、ある導入先の空振りで共通側を削ることになる。
- 迷ったら `detail` に迷いを書く。判定を空にはしない（語彙の外は検査が落とす）。

## 読み方（v1.x の仕分け）

```bash
node scripts/lib/check-harness-score.mjs --summary
```

| 判定 | 規則 |
| --- | --- |
| `keep` | `stopped` が 1 件でもある |
| `keep(costly)` | `stopped` があり `obstructed` もある。残すが費用（minutes）を見る |
| `fix-or-drop` | `stopped` が無く `missed` がある。直せるなら直し、直しても見逃すなら外す |
| `drop` | `stopped` も `missed` も無く `obstructed` だけ |

v1.x の CHANGELOG には「どの行を根拠に何を残し・直し・削ったか」を書き、根拠になった行を
`docs/plugin/evidence/` に写す（次の版でも同じ手順で回すため）。

## 限界

- **自己申告。** 行の中身が本当に起きたことかは機械で見ない。見るのは形・語彙・参照先の実在だけ。
  裏取りは `ref` の先（docs/sessions・journal）を人が読む。
- **書き忘れは検知できない。** issue を閉じたのに行が無い、を機械は知らない（docs/sessions の存在と突き合わせる
  検査は作っていない。証明フェーズの本数が増えて書き忘れが実際に出たら考える）。
- **重さを数えない。** 本物のバグを止めた 1 行と誤パスを止めた 1 行は同じ 1 件。`cost` は任意なので、
  書かれていなければ `obstructed` の重さが読めない。
- **部品名は自由記述。** 表記ゆれは別の部品になる。集計で気づいたら行を直す（語彙表は作っていない。
  部品が増えるたびに表を直す手間のほうが大きいと判断した）。
- **導入先の行を集める手段はまだ手作業。** 各リポジトリの `harness-score.jsonl` を人が持ち寄る。
  自動で集める仕組みは、導入先が 3 つを超えたら考える。
