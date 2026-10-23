---
name: verify
description: コミット直前に、変更に要る検査を機械で導いて回し、回せないものは理由つきで「未実施」と書く。docs / tests だけの変更を除く全コミットの前に使う。失敗しても直さず報告だけする。
---

# verify — コミット直前の検査

目的: 「単体テストだけ緑にして終える」（C-041）をコミットの手前で止める。
何を回すかは人が考えず `derive-test-selection` に導かせ、結果は引き継ぎメモ 04 表に
そのまま貼れる形で返す。**失敗しても直さない。** 直すのは呼び出し側の仕事で、
直した後にこのスキルをもう一度回す。

## 手順

1. 要る検査の表を得る（未コミット分も含めて判定される）:
   ```bash
   bash scripts/derive-test-selection.sh origin/main --format table
   ```
   パスから読めない性質は `--risk authz_change,retry_possible,contention,external_side_effect`
   のうち該当するものを申告する。
2. 表で「要実施: 毎回」「要実施: 変更時」の行を、下の対応表のコマンドで順に回す。
   連結コマンド（パイプ・`&&`・`;`）は hook が止めるので、1 回に 1 コマンドずつ打つ。
3. 実 DB が要るものは `supabase start` してから回し、終わったら `supabase stop` で止める。
4. SessionStart の鮮度警告（統合テスト・E2E・変異計測・RLS 変異）に出ているものは、
   表に無くても回す（「表に無い見張り」）。
5. 表の状態列を 4 値で書き換えて出力する（`route:` 行も残す）。

## 対応表（表の行 → コマンド）

| 行 | コマンド | 前提 |
| --- | --- | --- |
| 型検査 | `npm run typecheck` | — |
| lint / PII のログ流出検査 / 時刻・タイムゾーン | `npm run lint` | — |
| unit / migration 静的 / DB 制約 ratchet / セキュリティヘッダ / ワークフロー同期 | `npm test` | — |
| build | `npm run build` | — |
| hook 回帰 | `scripts/*.test.sh scripts/lib/*.test.sh` の全件ループを一時スクリプトに書き、`LC_ALL=C.UTF-8 bash <そのファイル>` で回す（約 8 分。実行中は編集しない） | node_modules |
| 「実行:」に `bash` / `node` / `git` / `npm audit` が書かれた行 | 表のコマンドをそのまま | — |
| RLS/IDOR 統合 / 冪等性 / 同時実行 / 業務不変条件 | `bash scripts/run-integration-tests.sh` | ローカル Supabase・`.env.test` |
| 生成型の鮮度 | `bash scripts/check-generated-supabase-types.sh` | ローカル Supabase |
| 直接攻撃の実測 | `./node_modules/.bin/playwright test e2e/api-cross-facility-attack.spec.ts` | ローカル Supabase |
| E2E（`e2e/` に触れたとき。他は main マージ後の自動実行） | `bash scripts/run-e2e-tests.sh` | ローカル Supabase |

### 表に無い見張り（SessionStart の鮮度警告が出ているとき）

| 警告 | コマンド | 目安 |
| --- | --- | --- |
| 製品コードの変異計測（`src/` の認可ファイルに触れた） | `bash scripts/run-mutation-tests.sh` | 約 2 分 |
| RLS 変異（`supabase/migrations/` に触れた） | `bash scripts/check-rls-mutation.sh` | 約 10 分・実 DB |

`run-*.sh` と `check-rls-mutation.sh` は結果を `logs/*-runs.jsonl` に exit code で残す
（引数付きの部分実行は記録されない）。この記録を Stop hook
`scripts/check-full-run-before-finish.sh` と SessionStart の鮮度 hook が読む。

## 出力の形（04 表にそのまま貼る）

derive の表を、状態列だけ 4 値で書き換えて返す:

- ✅ 実施（自動テスト: パス）— 回して緑。証跡列にコマンドと件数
- ➖ 今回不要 — derive が出した理由をそのまま残す（自分で理由を作らない）
- 🟡 一部 — 部分実行、または一部が赤。何を残したかを証跡列に
- ⬜ 未実施 — 必要なのに回せなかった。**理由必須**
  （Supabase を起動できない・`.env.test` が無い・時間切れ 等）

赤になった行は赤のまま書く。**「回していない」を「通った」にしない。**
表の後に、赤の行があれば失敗したテスト名と要旨を箇条書きで添える。直さない。

## 限界

- 起動は Claude Code の規約（2.1.286 以上。セッション開始時にこのスキルが存在し、
  `includeGitInstructions` が off でないとき。docs / tests だけの変更では呼ばれない）と
  LLM の判断に依存する。呼ばれなかったことは機械で分からない
  （`docs/agents/undetectable-rules-inventory.md`）
- `npm test` / `npm run lint` 等は記録が残らない。記録が残るのは `run-*.sh` 系だけ
- 回したかどうかしか見ない。通した内容が十分かは見ない
