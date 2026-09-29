# SPEC 03: 読むだけの操作を止めない

- feature: `codex-hook-parity-03-readonly-false-deny`
- 重要度: 低 / 影響: **Claude Code と Codex の両方**

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

**中身を見るだけ・版を確かめるだけ**の操作が、止まらなくなります。

いまは、スキップの印を `cat` で読むだけでも、`psql --version` で版を確かめるだけでも止まります。Claude Code では確認を 1 回押せば済みますが、Codex では止まったら人が手で実行するしかないので、調べものが進みません。

## 操作の流れ

| 操作 | いま | 変更後 |
| --- | --- | --- |
| `cat .claude/.verify-state/x.skip` | 止まる | 通る |
| `ls -l .claude/.verify-state/x.skip` | 止まる | 通る |
| `psql --version` | 止まる | 通る |
| `psql --help` | 止まる | 通る |
| `touch .claude/.verify-state/x.skip` | 止まる | 止まる |
| `cat a > .claude/.verify-state/x.skip` | 止まる | 止まる |
| `psql -c "select 1"` | 止まる | 止まる |
| `psql --version; psql -c "drop …"` | 止まる | 止まる |

## 受け入れ条件

- [ ] 上の表の通りになる
- [ ] 読むコマンドでも、**書き込み先の指定**（`>` や `>>`、`tee`）が付いていたら止まる
- [ ] `psql` は、版の確認とヘルプ**だけ**が通る。ほかの引数が 1 つでも付いたら止まる
- [ ] Claude Code と Codex で同じ判定になる

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 |
| --- | --- | --- | --- |
| 1 | そもそも直すか | 直す（ただし最後でよい） | 守りを緩める変更なので、急ぐ理由は無い。困るのは Codex で調べものをするときだけ |
| 2 | 「読むだけ」と認めるコマンドは `cat` / `ls` / `head` / `tail` / `wc` / `stat` / `file` / `grep` の 8 語でよいか | はい | 少なく始める。足りなければ後から足せるが、緩めすぎは戻しにくい |
| 3 | `supabase --version` なども通すか | 今回はしない | いま止まっていない（`supabase db execute` と `db push` だけが対象のため） |

## 気をつけること

これは**守りを緩める**変更です。通すものを決め打ちにし、「読むだけに見えるが実は書く」書き方（出力の向け先を変えるなど）は止めたままにします。

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 根拠（2026-09-29 実測）

| 入力 | スクリプト | 結果 |
| --- | --- | --- |
| `cat .claude/.verify-state/x.skip` | `codex-skip-marker-deny.sh` | deny |
| `ls -l .claude/.verify-state/x.skip` | 同上 | deny |
| `psql --version` | `check-direct-ddl-execution.sh` | deny（Codex 実機でも 2026-09-28 に deny を記録済み） |

`check-skip-marker-write.sh` はコマンドをセグメントに分けず、文字列全体に `FULL_PATH_PATTERN` を当てている。`check-direct-ddl-execution.sh` は `^psql` に一致した時点で引数を見ずに deny する。

## 実装セット

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/check-skip-marker-write.sh` / `.test.sh` | セグメント分割と読み取り判定を追加 |
| B | `scripts/check-direct-ddl-execution.sh` / `.test.sh` | `psql` の版確認・ヘルプを除外 |

A は SPEC 01 の後、B は SPEC 02 の後に行う（同じファイル）。

## 方針

- A: `split_segments` を導入し、セグメントごとに判定する。セグメントの先頭語が読み取り 8 語で、かつセグメントに `>` も `tee` も含まれなければ、そのセグメントは見送る。それ以外は従来通り
  - `split_segments` は `|` で切るので、`cat x | tee .claude/.verify-state/a.skip` は `tee …` のセグメントが残って止まる
  - `>` の判定は「セグメントに `>` が含まれるか」の単純一致（`2>/dev/null` でも止まる側に倒れる。緩めすぎない）
- B: 正規化後のセグメントが `psql` + （`--version` / `-V` / `--help` / `-?` のいずれか 1 語）**だけ**のときに見送る
- 2026-09-28 の evidence（`psql --version` で deny を実測）は当時の記録として残す。新しい挙動は新しい evidence に書く

## テスト観点

- 赤の確認: 上の 3 入力が、直す前は deny・直した後は沈黙
- 止まったままの対照: `cat a > …/x.skip` / `cat a >> …/x.skip` / `cat a | tee …/x.skip` / `ls …/x.skip; touch …/y.skip` / `psql --version -c "drop"` / `psql --version; psql -c 1`
- cwd が `.claude/.verify-state` のときの `cat a.skip`（通る）と `touch a.skip`（止まる）
- 既存テストの全件が変わらず通る

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし
- 新しい値: なし
- 列挙: 読み取り 8 語、psql のフラグ 4 つ、決めること 3 件。本文と一致
- 信号の意味: **deny / ask が出ていた入力の一部が沈黙に変わる**。これを数えている下流（gate の集計など）があれば件数が減る。実装時に `summarize-gate-passfail.sh` がこの 2 本を数えているか確認する
