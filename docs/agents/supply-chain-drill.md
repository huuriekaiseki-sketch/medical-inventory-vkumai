# 供給網の侵害演習（issue #757 の 30）

配布物・依存・CI が**実際に差し替えられた状態**を作り、既存の検知器が気づくかを実測するランブック。
[`fault-injection-drill.md`](./fault-injection-drill.md)（ゲートが本当に blocked を返すか）と同じ型で、
対象を「自分たちが作る成果物」から「外から入ってくるもの・外へ出ていくもの」に広げたもの。
到達範囲の表は blast-radius.md（issue #757 の 39）の 02x（開発・配布の経路）。

## 方針

- 改ざんはすべて **一時ディレクトリのコピー** に対して行う。リポジトリの追跡ファイルには触れない。
  `scripts/supply-chain-drill.sh` がその前提で書かれているので、手で改ざんしない。
- **未検知のシナリオを消さない**。「検知できない」は演習の失敗ではなく成果物で、
  塞ぐか「引き受ける」かを決めて実施記録に残す。
- 検知器を足したら、その検知器を騙すシナリオをここに足す（検知器とシナリオは 1 対 1 に育てる）。

## 実施タイミング

1. 四半期に 1 回。[`fault-injection-drill.md`](./fault-injection-drill.md) の定期訓練と同じ回にまとめて行う
2. 配布経路を変えたとき（marketplace リポジトリの移動、公開範囲の変更、CI の実行環境の変更）
3. 依存に大きな更新を入れたとき（major 更新、レジストリの変更）

## シナリオと期待

| シナリオ | 作る侵害 | 検知するはずのもの | 期待 |
| --- | --- | --- | --- |
| `plugin-swap` | 配布済みプラグインの hook スクリプトに 1 行足す | `scripts/check-plugin-integrity.sh` | 検知（sha256 不一致） |
| `plugin-inject` | manifest に無いファイルを差し込む | 同上 | 検知（余分なファイル） |
| `plugin-partial` | 配布物からファイルを 1 つ落とす（部分適用・古い版の混在） | 同上 | 検知（欠落） |
| `lockfile-swap` | `package-lock.json` の `resolved` を別レジストリへ向ける | `scripts/check-lockfile-integrity.test.sh` | 検知（registry.npmjs.org 以外） |
| `action-tag` | GitHub Action の参照をタグのまま上流で動かす | （無し） | **未検知**（下記） |

## 実行手順

```bash
bash scripts/supply-chain-drill.sh              # 全シナリオ
bash scripts/supply-chain-drill.sh plugin-swap  # 1 つだけ
```

出力の「検知 N 件 / 未検知 M 件」を下の実施記録に写し、未検知の行ごとに次のどれかを書く。

- **塞ぐ**: 検知器を足す issue を立てる（#757 の番号があればそれを書く）
- **引き受ける**: 塞がない理由と、代わりに何を見るかを書く
- **保留**: 判断待ちの理由と、いつ決めるか

## 検知できないこと（この演習の限界）

- **manifest ごと書き換えられた配布物**: `check-plugin-integrity.sh` は manifest と実物を突き合わせるだけで、
  manifest 自体の真正性は見ていない（署名が無い）。配布リポジトリへの書き込み権を取られたら気づけない
- **レジストリ上の正規パッケージの中身**: `resolved` と `integrity` は「registry.npmjs.org のその版」を
  固定するだけで、その版の中身が悪意を持つ場合は素通りする（`npm audit` は公表済みの脆弱性のみ）
- **実行時の挙動**: どのシナリオも静的な突合であって、走らせたときに何をするかは見ていない
- **人**: 正規の権限を持つ人が正規の手順で悪意あるコードを入れる経路は、この演習の対象外
  （human-bypass-inventory.md、issue #757 の 33 と PR レビュー）

## 実施記録

### 2026-09-07（初回）

`bash scripts/supply-chain-drill.sh` を実行。**検知 4 件 / 未検知 1 件**。

| シナリオ | 結果 | 判断 |
| --- | --- | --- |
| `plugin-swap` | ✅ 検知（sha256 の不一致） | — |
| `plugin-inject` | ✅ 検知（manifest に無いファイル） | — |
| `plugin-partial` | ✅ 検知（ファイルの欠落） | — |
| `lockfile-swap` | ✅ 検知（registry.npmjs.org 以外の resolved） | — |
| `action-tag` | ⚠️ 未検知 | **保留**（下記） |

**未検知 1 件の詳細**: `.github/workflows/` は外部 action を actions/checkout@v7・actions/setup-node@v7・
supabase/setup-cli@v3 の **3 種すべてタグで参照**している。タグは上流のリポジトリが動かせるので、
こちらのファイルは 1 バイトも変わらないまま、CI で実行されるコードだけが変わる。CI は
`SUPABASE_SERVICE_ROLE_KEY` 等の secrets を持つジョブがあるため、被害は CI の権限まで届く。

判断は **保留**。commit SHA での固定（actions/checkout@<sha> の形）は検知ではなく予防として効くが、
更新のたびに SHA を書き換える手間が増え、Dependabot 相当の自動更新が無い今は「古い action を
使い続ける」別のリスクと取り替えることになる。依存の月次棚卸し（#757-21）に「action の版と
参照方法」の行を足して、そこで判断する。

**この回で分かったこと**: 検知できた 4 件はどれも「こちらの手元にある成果物の突合」で、
未検知の 1 件は「上流が動かせるもの」だった。供給網の弱点は自分の成果物ではなく参照の仕方に出る。
