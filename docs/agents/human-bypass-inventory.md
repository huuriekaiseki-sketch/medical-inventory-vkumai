# 人間系の回避経路の棚卸し（H-xxx）

安全装置（hook・CI・RLS・停止①②・監査）は、**人が意図して迂回できる**。緊急対応・古い手順書・
「AI が検証済みと言った」で回避したとき、それが記録に残るか、後から説明できるかを装置ごとに一覧に
したもの（issue #757 の 33）。[undetectable-rules-inventory.md](./undetectable-rules-inventory.md) が
「センサーの無いルール」を、[actuator-inventory.md](./actuator-inventory.md) が「検知後の是正」を扱うのに
対し、ここは「センサーも是正もあるが、人が横を通れる経路」を扱う。

## 方針

- 迂回を**禁止しない**（緊急時に必要になる）。代わりに **迂回した事実と理由を残す**。
  `bash scripts/log-manual-override.sh --safeguard H-xxx --actor <名前> --reason "<理由>"` が
  `logs/manual-overrides.jsonl` に 1 行残す（worktree 横断で 1 か所。`scripts/lib/resolve-log-dir.sh`）。
  DB の変更そのものは監査ログ（P-060）が残すが、「なぜ手動でやったか」はここにしか残らない。
- 迂回が**機械的に記録される**経路（監査ログ・スキーマドリフト検知・git 履歴）はそれを正とし、
  記録されない経路だけ手動記録を義務にする。
- CI をすり抜ける最も安い経路（テストの `.only` を残す・unit テストの無条件 `.skip`）は
  `scripts/check-human-bypass-inventory.test.sh` が機械で止める（新規発生 0 の ratchet）。

## 状態の読み方

| 状態 | 意味 |
| --- | --- |
| 記録される | 迂回しても機械が記録する（誰が・いつ・何を）。理由は手動記録で補う |
| 一部 | 変更の一部だけ記録される、または記録はあるが理由・経路が分からない |
| 記録されない | 迂回しても何も残らない。手動記録（`log-manual-override.sh`）が唯一の痕跡 |
| 不可 | 人にも迂回できない（DB が拒否する） |

## 一覧

| ID | 安全装置 | 人が迂回する経路 | 迂回が記録されるか | 迂回するときの手続き | 状態 |
| --- | --- | --- | --- | --- | --- |
| H-001 | PR と CI（赤なら直す） | Free プランは required check を設定できず、赤 check のままマージできる。main へ直接 push もできる（ブランチ保護なし）。**2026-09-11 から、GitHub の main への直接 push は pre-push hook（`scripts/git-hooks/pre-push`）が止める**（`bash scripts/install-git-hooks.sh` を打った clone のみ）。横を通れるのは `git push --no-verify` と、hook を入れていない clone | マージは PR の checks に赤が残る。直接 push は git 履歴だけ（PR なし・04 表なし） | 赤マージは `log-manual-override.sh --safeguard H-001` で理由を残す。直接 push はしない（緊急でも PR を作る）。`--no-verify` で直接 push したら `--safeguard H-001` で理由を残す。GitHub 復旧時の入れ方は [`merge-rehearsal.md`](./merge-rehearsal.md) | 一部 |
| H-002 | 依存追加の ask hook（`check-dependency-change.sh`） | Claude Code の外の端末で `npm install` する。Codex は deny ラッパーだが同じく端末からは通る | package-lock.json の差分は PR に出る。Stop hook が「依存の変更」欄の有無を警告する（PR 経由のみ） | 端末で入れたときも 00 欄「依存の変更」を書き、`--safeguard H-002` で残す。H-001 の直接 push と組み合わせると無記録になる | 一部 |
| H-003 | 直接 DDL の deny hook（`check-direct-ddl-execution.sh`） | Supabase Studio の SQL Editor・端末の psql・ダッシュボードの Table Editor | DDL は日次のスキーマドリフト検知が issue 化する（`schema_drift_log`）。データ変更は監査ログに `actor_role = postgres / service_role`・`actor_id = null` で残る | Studio で触ったら `log-manual-override.sh --safeguard H-003`。DDL は必ずキャッチアップ migration に書く（`.claude/rules/db-schema.md`） | 記録される |
| H-004 | RLS（施設境界） | service role key（サーバー側・CLI・Studio）は RLS を通らない。アプリ内では admin 系 route と `requireAdmin` だけが使う（`src/lib/supabase/server.ts`） | 書き込みは監査ログに `service_role` として残る。**読み取りは記録されない**（誰が何を読んだかは分からない。#757-24） | 本番で service role を手で使うときは `--safeguard H-004`。読み取りだけでも記録する | 一部 |
| H-005 | 停止①②（AIDD フローの人間レビュー） | ルーターを通さず直接実装する | PreToolUse hook が「run-manifest が無い」と警告するだけ（セッション内で消える）。PR 本文の route 欄が唯一の痕跡 | 小さな変更は許容（`feedback_workflow`）。高リスクパスを直接触ったときは PR 本文にその旨を書き、`--safeguard H-005` で残す | 記録されない |
| H-006 | hook 全体 | `.claude/settings.json` を書き換える・hook を無効化して起動する・Claude Code の外で作業する | settings.json の変更は PR に出る（hook-live が要求される）。無効化しての起動は残らない | settings の変更は必ず PR。無効化して作業したら `--safeguard H-006` | 記録されない |
| H-007 | 引き継ぎメモの 04 表（4 値） | 回していない検査に ✅ と書く | Stop hook は見出しと 4 値の形しか見ない。中身の真偽は検査できない | derive の出力を貼る規約と、CI の緑で裏を取る。緑が無い種別（統合・E2E）は証跡（件数・所要時間）を書く。回さずに ✅ にしたと後で分かったら `--safeguard H-007` で残して直す | 記録されない |
| H-008 | Vercel / Supabase ダッシュボードの設定（環境変数・Auth 設定・RLS の UI 編集） | ダッシュボードで直接変える | RLS の変更はスキーマドリフト検知が拾う。環境変数・Auth 設定は残らない（#757-35） | 変えたら `--safeguard H-008`。#757-35 で期待値との定期比較を作る | 一部 |
| H-009 | 本番データの手修正（緊急対応） | Studio・service role でのデータ UPDATE / DELETE | 監査ログに残る（`actor_role = postgres / service_role`）。理由は残らない | 必ず `--safeguard H-009 --reason` を残し、可能なら issue を作る | 記録される |
| H-010 | 古い手順書に従う | 期限切れの runbook・古い SPEC.md・古い README の手順をそのまま実行する | runbook 4 本は「次回実施予定日」の期限監視（SessionStart + maintenance-digest）で古さが分かる。SPEC.md・README は鮮度の検査なし（docs 整合性はリンク切れだけ） | 手順書を使うときは最終更新日を見る。古い手順で本番を触ったら `--safeguard H-010`。SPEC.md の鮮度は「仕様書と実装の乖離」（security-test-catalog）で未 | 一部 |
| H-011 | 秘密情報の手渡し | service role key・token を chat・AI・メモに貼る | リポジトリに入れば秘密情報の走査が止める。chat・AI の transcript・メモに貼った場合は残らない（D-041） | 貼らない。貼ったらローテーション（#757-29） | 記録されない |
| H-012 | テストを黙らせる | `it.only` / `describe.only` を残して他を回さない、unit テストに無条件の `.skip` を足す | `scripts/check-human-bypass-inventory.test.sh`（CI `hooks-test`）が `.only` を 0 件、`src/` と `supabase/` の無条件 `.skip` を 0 件で固定する。e2e の条件付き `test.skip(条件, 理由)` は許す | 一時的に skip するなら理由付きの issue を作り、`it.skip` ではなく `it.todo` か条件付き skip にする | 不可 |
| H-013 | AI の「検証済み」を信じて確認を省く | 完了報告の証跡を見ずにマージする | CLAUDE.md「完了報告の監査指示」で AI 側の断定を抑える。人側の省略は記録されない | 04 表の ✅ には証跡（件数・コマンド）が付いていることを見る。証跡を見ずにマージしたと分かったら `--safeguard H-013` で残す（#757-39 の「検知までの時間」の材料） | 記録されない |

## 迂回した事実の記録

```bash
bash scripts/log-manual-override.sh --safeguard H-009 --actor masanori --reason "発注が止まっていたため Studio で価格を手修正" --ref "issue #123"
```

- 記録先 `logs/manual-overrides.jsonl`（gitignore。`scripts/lib/resolve-log-dir.sh` が解決するメイン worktree 直下）
- 記録は追記のみ。月次サマリ（`scripts/gate-effectiveness-monthly-check.sh` の型）に「先月の手動迂回 N 件」を足すのは次の段階
- 監査ログ側の対応行は `audit_log` を `actor_role in ('postgres', 'service_role')` と `occurred_at` で引く

## 限界

- **迂回を禁止しない。** 緊急時に安全装置の横を通る必要はあるので、目的は「通れなくする」
  ではなく「通ったことが残る」。**残らない経路が 5 件あり、そこは本人が言わない限り分からない。**
- **記録されない経路は、この表に載っていること自体が唯一の防御**という状態。
  読まれなければ効かない（[`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md) と同じ性質）。
- **人の判断の質は見ない。** 「記録される」経路でも、記録された理由が妥当かは誰も検査しない。
- **思いつけた迂回路しか載らない。** 新しい安全装置を足すと、その横を通る道も同時に生まれるが、
  この表へ足すのは人の作業。

## 更新の引き金

- 安全装置を足したとき（hook・CI ジョブ・RLS ポリシー・トリガー）: その装置の行を足し、「人が迂回する経路」を 1 つ以上書く
- 利用者が開発者以外になったとき: H-004（service role の読み取り）と H-009（本番の手修正）を「記録されない」から昇格させる設計（#757-24・39）
- ブランチ保護が使えるプランになったとき: H-001 を「不可」に
