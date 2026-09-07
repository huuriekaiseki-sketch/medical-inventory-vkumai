# データの残存先の棚卸し（D-xxx）

施設が退会し、利用者が退職したとき、その施設・利用者のデータが **DB の行以外のどこに残るか**を
場所ごとに一覧にしたもの（issue #757 の 28。12 の DB 側 = I-052 の続き）。「消えたはず」を DB の
CASCADE だけで判断すると、履歴・ログ・バックアップ・メール・開発機・AI の記録に残る。
対象データは脅威モデル（threat-model.md、22 番の PR）の資産 A-01（患者識別情報）・A-02（施設の価格）・
A-03（発注・返却）・A-04（所属）。

## 更新ルール

- 列は固定 7 列: ID / 場所 / 何が残るか / いつまで・誰が消すか / 確認方法 / 守るテスト / 状態。列の中に `|` を書かない。
- ID は `D-` + 3 桁。区分ごとに 10 刻み（DB 内 00x / 認証とセッション 01x / 実行環境のログとキャッシュ 02x /
  バックアップと外部 03x / 開発機と AI 04x）。欠番は詰めない。
- 状態は 4 語のみ: 消える（機械で消え、守るテストがある）/ 残らない（そもそも書かれない。根拠を「何が残るか」に書く）/
  残る（意図）（証跡・別施設の利用者など、残す理由を書く）/ 未確認（保持期間や中身を確かめていない。`#757-N` を必ず書く）。
- 「守るテスト」列はバッククォートでパスを書く。無い行は `未`。`scripts/check-data-lifecycle-inventory.test.sh`
  （CI `hooks-test`）が列数・ID・状態・パスの実在・未確認の #757-N を検査する。
- **更新の引き金**: 新しい保存先（Storage・添付・エクスポート・外部連携・メール送信 API・キャッシュ）、
  Vercel / Supabase のプラン変更（保持期間が変わる）、実施設の利用開始（開発機と AI の行を見直す）。

## 一覧

### DB 内（00x）

| ID | 場所 | 何が残るか | いつまで・誰が消すか | 確認方法 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| D-001 | 施設スコープの 12 表（所属・発注 3 種・明細・返却・消耗品・価格） | 施設削除と同時に消える（FK の ON DELETE CASCADE） | 施設削除（admin の DELETE /api/facilities/[id]）と同時 | 施設を消して各表を数える | `supabase/__tests__/integration/facility-delete-cascade.integration.test.ts`（I-052。12 番の PR） | 消える |
| D-002 | `price_histories`（施設別価格の変更履歴） | 2026-09-06 まで孤児として残っていた（`hospital_prices` への FK が無い）。20260906000007 のトリガーで親と同時に消える | 施設削除・価格行の削除と同時 | 同上 | `supabase/__tests__/integration/facility-delete-cascade.integration.test.ts`（12 番の PR） | 消える |
| D-003 | `audit_log`（変更前後の値を含む） | 施設・発注の DELETE を含む全変更の old_data / new_data。患者 ID・価格を含む | **残す**（削除の証跡。FK を張らず、append-only）。保持期間と削除手順は未定（#757-4 の残り）。読めるのは admin と、その施設の所属者（施設が消えた後は admin だけ） | `audit_log` を facility_id / row_id で引く | `supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts`（P-060〜P-062） | 残る（意図） |
| D-004 | `auth.users`（利用者本人） | 施設削除では消えない（別施設に所属しうる）。利用者削除（admin の DELETE /api/admin/users → `auth.admin.deleteUser`）で消え、`user_facilities` は CASCADE | admin が利用者を削除したとき | 削除後に `getUser` が拒否されることを見る | `supabase/__tests__/integration/permission-revocation.integration.test.ts`（P-023。27 番の PR） | 残る（意図） |

### 認証とセッション（01x）

| ID | 場所 | 何が残るか | いつまで・誰が消すか | 確認方法 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| D-010 | 利用者のブラウザの Cookie（Supabase のセッション） | アクセストークン（JWT。`user_role` クレームを含む）とリフレッシュトークン | 権限変更は次のリクエストから効く（P-023）。クレームはアクセストークンの期限（Supabase 既定 1 時間）まで古い。利用者削除でリフレッシュは失効 | P-023 のテスト | `supabase/__tests__/integration/permission-revocation.integration.test.ts`（27 番の PR） | 消える |
| D-011 | ブラウザの localStorage / sessionStorage / IndexedDB | 使っていない（`src/` に参照なし。Supabase SSR は Cookie のみ） | — | `grep -rn localStorage src` が 0 件 | 未 | 残らない |

### 実行環境のログとキャッシュ（02x）

| ID | 場所 | 何が残るか | いつまで・誰が消すか | 確認方法 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| D-020 | Next.js のデータキャッシュ・ISR | 使っていない（全 route が動的 ƒ。`revalidate` / `unstable_cache` の参照なし） | — | `npm run build` の route 一覧が全部 ƒ | 未 | 残らない |
| D-021 | Vercel のランタイムログ（サーバー側 console） | `log-safe.ts` で伏せた後の文字列だけ（患者 ID・メール・行の中身は出ない）。リクエストの URL に施設 ID・発注 ID（UUID）は乗る | 保持期間は Vercel のプランに依存（Hobby は短い）。ダッシュボードで確認する | Vercel の Logs 画面で保持期間と検索結果を見る | `src/lib/log-safe.test.ts`、`scripts/check-pii-leak.test.sh` | 未確認（#757-28: 保持期間をダッシュボードで確認して記入） |
| D-022 | Supabase のログ（PostgREST・Auth・Postgres） | リクエストの URL・施設 ID・利用者 ID。Postgres のエラーログには CHECK 違反の DETAIL（行の中身）が出うる | 保持期間は Supabase のプランに依存。ダッシュボードの Logs で確認する | Logs Explorer で `Failing row contains` を検索する | 未 | 未確認（#757-28: 中身と保持期間を確認して記入。DETAIL が出るなら Postgres の `log_error_verbosity` を検討） |

### バックアップと外部（03x）

| ID | 場所 | 何が残るか | いつまで・誰が消すか | 確認方法 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| D-030 | Supabase のバックアップ・PITR | 削除前の行が保持期間分そのまま残る（削除は取り消せない代わりに、復元すると戻る） | 保持期間はプランに依存。復元で消したデータが戻る前提を #757-11・23 の演習で扱う | ダッシュボードの Backups を見る | 未 | 未確認（#757-23: 復元後の検証で「消したはずのデータが戻らないか」を含める） |
| D-031 | 招待メール（Supabase Auth が送る） | 受信者のメールアドレスとリンクだけ。患者・価格・発注は乗らない | 受信者の受信箱に残る。こちらからは消せない | `inviteUserByEmail` の本文テンプレート（Supabase の Auth → Email Templates） | 未 | 残る（意図） |
| D-032 | GitHub / GitLab のリポジトリ | コードだけ。業務データは無い。秘密情報は走査で止める | — | `bash scripts/check-secret-leak.test.sh`、`bash scripts/check-pii-leak.test.sh` | `scripts/check-secret-leak.test.sh`、`scripts/check-pii-leak.test.sh` | 残らない |
| D-033 | エクスポート・CSV・添付ファイル・Storage・外部連携 | 機能が無い | — | 追加したときにこの表へ行を足す（更新の引き金） | 未 | 残らない |

### 開発機と AI（04x）

| ID | 場所 | 何が残るか | いつまで・誰が消すか | 確認方法 | 守るテスト | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| D-040 | 開発機のローカル Supabase・`.env*`・`e2e/.auth/`・`test-results/`・`logs/` | 本番データは複製しない運用。テストの fixture は架空（`example.test` のメール、ダミー施設名）。いずれも gitignore | 開発者が `supabase db reset` で消す | `git check-ignore`、fixture の命名 | `scripts/check-pii-leak.test.sh`（許可ドメイン外のメールが追跡ファイルに無い） | 残らない |
| D-041 | AI エージェントの記録（Claude Code の transcript・claude-mem・`logs/*.jsonl`） | 本番の service role key は AI に渡していない（ローカル Supabase のみ）。fixture は架空。ただし本番 DB を直接読む作業をした日は、その内容が transcript に残る | transcript は Claude Code の cleanup 期間、claude-mem は明示削除 | 本番データを読む作業をしたら、その日の transcript を確認する | 未 | 未確認（#757-28: 観測ログの中身の走査を機械化するか、本番読み取りを禁止する運用にするかを決める） |

## 読み方

- **消える**は D-001・D-002・D-010 の 3 つだけで、いずれも実 DB のテストが守る。
- **残る（意図）**は証跡（D-003）と、他施設にも属しうる利用者本人（D-004）、送信済みメール（D-031）。
- **未確認**の 4 つ（D-021・D-022・D-030・D-041）は保持期間か中身をダッシュボードで見れば埋まる。
  Vercel / Supabase の確認は #757-35（設定ドリフト）の棚卸しと同時に行う。
