# SPEC 01: Codex のファイル直接編集を止める

- feature: `codex-hook-parity-01-apply-patch`
- 重要度: 高 / 影響: Codex のみ
- 状態: 2026-09-29 承認（決めてほしいこと 3 件はおすすめの通り）。スクリプトとテストは実装済み。Codex CLI 0.147.0 の実機でも deny を実測済み（PR #858）

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

Codex が**ファイルを直接書き換える**ときにも、Claude Code と同じ 2 つの守りが効くようになります。

1. 検証をスキップする印（`.claude/.verify-state/*.skip`）を勝手に作らせない
2. `package.json` / `package-lock.json` を勝手に書き換えさせない

いまは、Codex がコマンド（`touch` や `npm install`）を使ったときだけ止まり、**ファイルを直接編集したときは何も起きずに通ります**。Claude Code ではどちらも止まります。

## なぜ起きているか

Claude Code と Codex では、ファイル編集の道具の名前と渡し方が違います。守りの部品は Claude Code の形だけを知っていて、Codex の形を「関係ない操作」として見送っています。

## 操作の流れ

| 操作 | Claude Code | Codex（いま） | Codex（変更後） |
| --- | --- | --- | --- |
| コマンドでスキップの印を作る | 確認が出る | 止まる | 止まる |
| **ファイル編集でスキップの印を作る** | 確認が出る | **通る** | **止まる** |
| コマンドで依存を足す | 確認が出る | 止まる | 止まる |
| **ファイル編集で `package.json` を変える** | 確認が出る | **通る** | **止まる** |
| 関係ないファイルを編集する | 何も出ない | 何も出ない | 何も出ない |

## 受け入れ条件

印の意味: ✅ 確認済み（断りが無ければスクリプト単体のテスト） / ➖ 該当せず / ⬜ 未実施

- ✅ Codex のファイル編集で、スキップの印を**作る・変える・消す・別名から移す**のどれも止まる
- ✅ Codex のファイル編集で、`package.json` / `package-lock.json` を触ると止まる（どの階層にあっても）
- ✅ 1 回の編集に複数のファイルが入っていて、そのうち 1 つでも該当すれば、その編集全体が止まる
- ✅ 編集する**中身の文章**に該当のファイル名が出てくるだけでは止まらない（例: 説明文書に `package.json` と書く）
- ✅ 関係ないファイルの編集では何も出ない
- ✅ 止めたときの説明文は、コマンドで止めたときと同じ（「Codex は確認を出せないので止めました。必要なら人が手で実行してください」）
- ✅ Claude Code 側の動きは変わらない（既存のテストがそのまま通る）
- ✅ **Codex の実機**で、印の作成と `package.json` の編集をそれぞれ 1 回ずつ試し、止まったことを記録に残す（2026-09-29、CLI 0.147.0。`docs/plugin/codex/evidence/2026-09-29-apply-patch-verify.md`）
- ➖ 実機で「Codex がファイル編集のときに守りの部品を呼ばない」と分かった場合は、**直さずに止まり**、既知の制約に書く（該当せず。実機は守りの部品を呼んだ）
- ✅ 既知の制約（KNOWN-LIMITS）を実態に合わせて書き直す（実機確認が未実施であることも書いた）

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 |
| --- | --- | --- | --- |
| 1 | Codex は `package.json` を**一切編集できなくなる**（`scripts` 欄だけの変更でも止まる）。これでよいか | はい | Claude Code でも全件で確認を出している。Codex は確認を出せないので止めるしかない。コマンド経由は既にこの扱い |
| 2 | 複数ファイルの編集は、1 つ該当したら**全体を止める**でよいか | はい | Codex は編集の一部だけを止められない |
| 3 | hook の登録（`hooks.json`）は**変えない**でよいか | はい | 公式の説明では今の登録のままでファイル編集にも反応する。登録を変えると、導入済みの人に**信頼のやり直し**が発生する。実機で反応しなかった場合だけ変える |

## 分かっていないこと

- ~~Codex CLI 0.147.0 が、ファイル編集のときに実際に守りの部品を呼ぶか~~ → 呼ぶ（2026-09-29 実測。登録を変えなくても反応した）
- ChatGPT desktop app と CLI 0.158 系での動き
- 実機で測ったのは「新しく作る」編集だけ。「変える・消す・移す」はスクリプト単体のテストのみ

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 根拠（2026-09-29 実測）

公式ドキュメント: ファイル編集は `tool_name: "apply_patch"`、内容は `tool_input.command`。matcher の `Edit` / `Write` は `apply_patch` のエイリアスで、`tool_name` は変わらない。

| 入力 | スクリプト | 結果 |
| --- | --- | --- |
| `apply_patch` + `*** Add File: .claude/.verify-state/x.skip` | `codex-skip-marker-deny.sh` | 沈黙（rc=0） |
| `apply_patch` + `*** Update File: package.json` | `codex-dependency-change-deny.sh` | 沈黙（rc=0） |

原因は `case "$TOOL_NAME"` が `Write|Edit|MultiEdit` しか持たず、`apply_patch` が `*) exit 0` に落ちること。

## 実装セット

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/check-skip-marker-write.sh` / `.test.sh` | `apply_patch` の分岐を追加 |
| B | `scripts/check-dependency-change.sh` / `.test.sh` | 同上 |
| 統合 | `docs/plugin/codex/KNOWN-LIMITS.md` / `docs/plugin/codex-vkumai/KNOWN-LIMITS.md` / `dist/plugins/` | 文書と生成物 |

A と B は別ファイルなので同時に進められる。

## 方針

- パッチの**ヘッダ行だけ**からパスを取り出す: `*** Add File: ` / `*** Update File: ` / `*** Delete File: ` / `*** Move to: `。本文（`+` / `-` / 空白で始まる行）は見ない
- 取り出したパスを 1 本ずつ既存の判定へ渡す（A は `FULL_PATH_PATTERN` と cwd 起点の判定、B は `basename` の一致）
- 取り出す関数は 2 本に同じものを置く（`split_segments` と同じ流儀）。共有 lib にすると生成器の配布対象が変わるので今回はしない
- ヘッダが 1 行も取れない `apply_patch` は沈黙（判定不能を deny にすると全編集が止まる）。この挙動は KNOWN-LIMITS に書く
- ラッパー 2 本（`codex-*-deny.sh`）は変更不要

## テスト観点

- 赤の確認: 上の 2 入力が、直す前は沈黙・直した後は ask（ラッパー経由で deny）
- Add / Update / Delete / Move to の 4 種
- 複数ファイルのパッチ（該当 1 + 非該当 2）
- 本文にだけパスが出るパッチは沈黙（対照）
- サブディレクトリの `package.json`、似た名前（`packages.json`）は沈黙
- 既存の `Write` / `Edit` / `MultiEdit` の結果が変わらない
- 同梱テスト（`check-dependency-change.test.sh`）に同じケースが入る

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし（モック不要）
- 新しい値: `tool_name` に `apply_patch` を追加。判定は「ヘッダのパスが該当 → ask」「該当なし・ヘッダなし → 沈黙」。下流のラッパーは ask → deny、沈黙 → 沈黙で、既存と同じ
- 列挙: ヘッダ 4 種、守り 2 本、決めること 3 件。本文と一致
- 信号の意味: Claude Code 側の入力・出力は変えない
