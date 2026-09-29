# SPEC 02: 前置き付きのコマンドを止める

- feature: `codex-hook-parity-02-command-prefix`
- 重要度: 中 / 影響: **Claude Code と Codex の両方**
- 状態: 2026-09-29 承認（決めてほしいこと 4 件はおすすめの通り）。スクリプトとテストは実装済み（PR #861）。配布した 0.1.4 の Codex 実機で確認済み（`docs/plugin/codex/evidence/2026-09-29-release-0.1.4-verify.md`）。Claude Code 側の実機では未確認

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

止めるはずのコマンドの**前に何かが付いていても**、止まるようになります。

いまは、コマンドが行の先頭にあるときだけ止まります。たとえば `psql …` は止まりますが、`PGPASSWORD=postgres psql …` は通ります。後者はローカルの Supabase へつなぐときの普通の書き方で、わざと隠した書き方ではありません。

## 対象になる守り

| 守り | 止めるもの |
| --- | --- |
| データベースの直接操作 | `psql` / `supabase db execute` / `--local` の無い `supabase db push` / `npx` 経由の `supabase` |
| 依存の変更 | パッケージ名を伴う `npm install` など |

## 操作の流れ

| 書き方 | いま | 変更後 |
| --- | --- | --- |
| `psql -c "…"` | 止まる | 止まる |
| `PGPASSWORD=postgres psql -c "…"` | **通る** | 止まる |
| `env psql …` / `sudo psql` / `time psql` / `command supabase db push` | **通る** | 止まる |
| `(psql -c "…")` | **通る** | 止まる |
| `bash -c "psql -c 1"` | **通る** | 止まる |
| `SUPABASE_ACCESS_TOKEN=x supabase db push` | **通る** | 止まる |
| `CI=1 npm install lodash` / `sudo npm install -g foo` | **通る** | 止まる（Claude Code では確認） |
| `npm --prefix web install foo` | **通る** | 止まる（同上） |
| `echo "psql"` / `grep psql docs` | 通る | 通る |
| `npm ci` / `npm install`（パッケージ名なし） | 通る | 通る |

## 受け入れ条件

印の意味: ✅ スクリプト単体のテストで確認済み / ⬜ 未実施

- ✅ 上の表の「変更後」がすべてその通りになる
- ✅ 前置きが 2 つ以上重なっても止まる（例: `sudo env PGPASSWORD=x psql`）
- ✅ 前置きの後ろが止める対象でなければ、何も出ない（例: `CI=1 npm test`）
- ✅ 読むだけのコマンド（`which` / `grep` / `echo` など）は、これまで通り通る
- ✅ Claude Code と Codex で、同じ書き方に対して同じ判定になる（同じ判定本体を通る。Codex 側はラッパーが確認を「止める」に読み替える）
- ✅ 既知の制約に「それでも通るもの」を書く

### 実装して分かったこと（仕様書に無かった判断）

| 判断 | 理由 |
| --- | --- |
| `command -v psql` / `command -V psql` は止めない | あるかどうかを調べるだけで、実行しない。前置きとして読み飛ばすと「psql を実行する」と誤って読む |
| `sudo -u postgres psql` を止めるため、前置きの語ごとに「次の 1 語を値として取るフラグ」の表を持つ | 表が無いと、`-u` の値 `postgres` をコマンドと読んで外れる。ローカルの PostgreSQL でよく使う書き方 |
| `yarn --cwd` / `pnpm --filter` は対象外のまま | 値を取るフラグは仕様書の 4 つだけにした。既知の制約に書いた |

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 |
| --- | --- | --- | --- |
| 1 | 前置きとして読み飛ばすのは `名前=値` と `sudo` / `env` / `command` / `time` / `nohup` / `exec` の 6 語でよいか | はい | 実測で通ったものと、その同類。増やすほど誤って止める危険が増える |
| 2 | `bash -c "…"` の中身まで見るか（`sh -c` / `zsh -c` も同じ扱い） | 見る | AI がよく使う書き方。見ないと 1 語足すだけで通る |
| 3 | `npm` の直後のフラグ（`--prefix web` など）を読み飛ばすか | 読み飛ばす。値を取るフラグは `--prefix` / `--workspace` / `-w` / `--registry` の 4 つだけ | 全フラグを正しく読むのは無理。代表だけにして、残りは既知の制約に書く |
| 4 | `bun` / `deno` など別の道具での依存追加は対象にするか | しない | vkumai は npm。対象を広げるのは導入先が増えてから |

## それでも通るもの（直さない）

- 変数に入れてから実行する、文字を符号化する、などの**わざと隠した書き方**
- `xargs psql` のように、別のコマンドに実行させる書き方
- 決めること 3・4 で対象外にしたもの

守りの目的は「普通に書いたら止まる」ことで、悪意のある回避を完全に防ぐことではありません（既存の方針のまま）。

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 根拠（2026-09-29 実測、すべて沈黙・rc=0）

DDL: `PGPASSWORD=postgres psql -h 127.0.0.1 -c "drop table x"` / `env psql -c "select 1"` / `sudo psql` / `(psql -c "select 1")` / `bash -c "psql -c 1"` / `time psql` / `SUPABASE_ACCESS_TOKEN=x supabase db push` / `command supabase db push`（8 件）

依存: `CI=1 npm install lodash` / `sudo npm install -g foo` / `env npm install foo` / `npm --prefix web install foo` / `bun add zod` / `npx npm install foo`（6 件。うち `bun add` は決めること 4 で対象外、`npx npm` は KNOWN-LIMITS 行き）

原因は、セグメント先頭（`^`）に固定した正規表現で判定していること。

## 実装セット

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/check-direct-ddl-execution.sh` / `.test.sh` | セグメントの正規化を追加 |
| B | `scripts/check-dependency-change.sh` / `.test.sh` | 同上 + npm のフラグ読み飛ばし |

A と B は別ファイルなので同時に進められる。B は SPEC 01 と同じファイルなので、01 の後に行う。

## 方針

- `strip_prefix` を追加し、判定の前にセグメントを正規化する。順に繰り返し適用: 先頭の空白 → 先頭の `(` `{` → `NAME=value`（引用符付きの値を含む）→ 前置き 6 語とそのフラグ
- `bash -c` / `sh -c` / `zsh -c` は、引数の引用符を外した文字列を**もう一度 `split_segments` に通す**（再帰は 1 段だけ）
- `is_readonly_segment` は正規化の**前**に評価する（`echo PGPASSWORD=x psql` を止めないため）
- `is_npx_supabase` も正規化後のセグメントで評価する
- 関数は 2 本に同じものを置く（既存の流儀）。2 本の一致は構造テストで見る（片方だけ直して乖離するのを防ぐ）
- bash 3.2（macOS 標準）で動くこと。プロセス置換は使わない

## テスト観点

- 赤の確認: 上の実測入力が、直す前は沈黙・直した後は deny / ask
- 前置きの重ね掛け
- 対照（沈黙のまま）: `CI=1 npm test` / `env` 単体 / `sudo ls` / `echo "psql"` / `FOO=psql ls`
- `supabase db push --local` は前置き付きでも通る
- 値に空白を含む代入（`PGPASSWORD="a b" psql`）
- 既存テストの全件が変わらず通る

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし
- 新しい値: なし（判定結果の種類は変わらない）
- 列挙: 前置き 6 語、値を取る npm フラグ 4 つ、実測 8 + 6 = 14 件、決めること 4 件。本文と一致
- 信号の意味: deny / ask の出力形式は変えない。**止まる範囲が広がる**ので、Claude Code 側で確認が出る回数が増える可能性がある（`CI=1 npm install foo` など）
