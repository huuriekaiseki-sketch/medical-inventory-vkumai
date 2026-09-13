# 2026-09-13 GitHub 復旧時に出す PR の下書き（アカウント停止中に用意）

GitHub アカウントが suspended で PR・CI が使えない間に、ローカル main（`recovery/local-main`）と
製品 issue 3 本（`feat/record-proxy-admin-denial`）を貯めた。復旧したらこの下書きをそのまま PR 本文にする。
**main へ直接 push しない**（pre-push hook が止める。H-001）。順番は PR 1 → マージ → PR 2。

```bash
git push origin recovery/local-main
```

```bash
git push origin feat/record-proxy-admin-denial
```

---

## PR 1: `recovery/local-main` → `main`（GitHub 停止中の 8 日分、2026-09-06〜13）

## 30秒サマリー
- 変更概要: 2026-09-06〜13 にローカル main へ直接積んだ 324 コミット（GitHub 停止中）を、CI を通してから正本へ入れる
- リスク: 高（migration 40 本超・proxy・RLS・認可の変更を含む。個々は当時ローカルで検証済みだが CI は一度も通っていない）
- 変更領域: DB / RLS / ロジック / UI / テスト / ハーネス（docs・scripts・dist）
- 証拠状態: 実測 6 件（2026-09-13 にローカルで CI 相当を完走）/ サンプル・未検証 1 件（CI 本体）
- 影響範囲: 936 ファイル（src 181・supabase 94・e2e 21・scripts 329・docs 60・dist 200）。内訳 feat 106 / fix 58 / docs 35 / test 33 / refactor 13 / merge 66
- ロールバック可能性: 低（migration を含む。個別 revert ではなく、問題のコミットを特定して forward fix する前提）

レビューしてほしい点:
1. CI（lint・hooks-test・dependency-audit・docs-integrity）が全部緑になること。**赤が出たら、この 8 日分のどのコミットが原因かを `git bisect` で特定する**（ローカルの hooks-test は CI と同じ並びで 150/150 だったが、環境差で落ちる可能性はある）
2. `.github/workflows` の変更が停止中に入っているか（入っていれば CI の定義自体が古い環境で書かれている）

## 00 目的・影響範囲・対象外
- 目的: GitHub 停止中にローカルで進めた作業を、CI を通した形で正本へ入れる
- 変更範囲: 上の内訳。個々のコミットの目的はそれぞれのメッセージに書いてある（1 コミット 1 目的で積んである）
- 対象外: 製品 issue 3 本（PR 2）
- 作業中に見つけた別件: worktree `remaining-tasks-check-f3afd7` の `config.worktree` に hooksPath の絶対パス上書きがあり hook が動いていなかった（e5919578 で修正・記録）
- 依存の変更: なし（package.json / package-lock.json に触れていない。`npm audit --omit=dev --audit-level=high` 0 件）

## 04 どう確認したか（テスト・検証）
| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 / lint / unit / build（毎回、CI） | ✅ 実施（自動テスト: パス） | 2026-09-13 ローカル。tsc 0 / lint 0 / unit 245 files 2,244 件 / build |
| hook 回帰（毎回、CI hooks-test） | ✅ 実施（自動テスト: パス） | `scripts/*.test.sh scripts/lib/*.test.sh` 150 本、CI と同じ並びでローカル実行 |
| RLS/IDOR 統合（変更時） | ✅ 実施（自動テスト: パス） | `npm run test:integration` 373 件（`db reset` 直後） |
| 直接攻撃の実測（変更時: auth / 認可 / RLS） | 🟡 一部 | 攻撃表 spec（P-017）は E2E 本走に含む。停止中の各コミットの手動攻撃は当時の記録（docs/sessions・コミットメッセージ）に依存 |
| E2E（節目: main マージ後） | ✅ 実施（自動テスト: パス） | `npm run test:e2e` 77 件 |
| 冪等性 / 同時実行 / 障害注入（変更時・節目） | 🟡 一部 | 停止中に入れた分は各コミットで実測済みと記録されているが、このセッションでは再実行していない |
| CI（GitHub Actions） | ⬜ 未実施 | GitHub 停止中。復旧後にこの PR で初めて回る |

- 上の数値はローカルの実測。verify-claims は未実施

## 05 何かあったらどうするか（観測・ロールバック）
- CI が赤 → `git bisect` で原因コミットを特定し forward fix。main には入れない
- マージ後: スキーマドリフト検知（日次）と夜間の不変条件検査が動くことを翌日確認

---

## PR 2: `feat/record-proxy-admin-denial` → `main`（証明フェーズ vkumai 3 本）

## 30秒サマリー
- 変更概要: (1) proxy が /admin を弾いた拒否を access_denials に残す (2) admin × facility_id 省略で一覧 5 route が 500 → 400 (3) RLS で見えない ID 指定 1 件取得を存在確認で拒否として残す。ほかに凍結 hook（H-014）と aal2_required ラベル
- リスク: 高（proxy.ts・auth 境界・拒否の証跡・service_role の新経路 W-023）
- 変更領域: ロジック / テスト / docs。DB・RLS・migration は無変更
- 証拠状態: 実測 14 件 / 未検証 1 件（CI）
- 影響範囲: `/login` の内部構造（Server Component の皮）、一覧 5 route の admin 契約、1 件取得 2 route の記録
- ロールバック可能性: 高（migration 無し。revert のみ）

レビューしてほしい点:
1. 「印（cookie）は偽造できるが actor_id はセッション由来」の限界（P-063）
2. `requireFacilityAccess` の `facilityIdRequired`（P-002 の補足）
3. service_role で存在確認する新経路 W-023（読むのは facility_id だけ、応答は 404 のまま）

## 00 目的・影響範囲・対象外
- 目的: ハーネス証明フェーズの vkumai 3 本。詳細と「止めた / 見逃した / 邪魔した / 費用」は `docs/sessions/2026-09-13-record-proxy-admin-denial.md`
- 対象外: RLS の 0 件のうち一覧の空配列と PostgREST 直叩き、読み取り監査（引き金付き）、MFA 未昇格の非 admin の記録
- 作業中に見つけた別件: 同メモの追記 2 本
- 依存の変更: なし

## 04 どう確認したか（テスト・検証）
| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 / lint / unit / build（毎回、CI） | ✅ 実施（自動テスト: パス） | tsc 0 / lint 0 / unit 246 files 2,265 件 / build |
| hook 回帰（毎回、CI hooks-test） | ✅ 実施（自動テスト: パス） | 150 本（1 本目の時点で全件。以後は触った検査を個別に再実行） |
| RLS/IDOR 統合（変更時） | ✅ 実施（自動テスト: パス） | 373 件（3 本それぞれの後に実行、pass 記録） |
| 直接攻撃の実測（変更時: auth / 認可 / RLS） | ✅ 実施（手動） | 偽ヘッダ・偽 cookie（not_admin / unauthenticated）・壊れた印・admin × facility_id 省略の再測定・施設 B → 施設 A の ID 直指定 |
| E2E（節目） | ✅ 実施（自動テスト: パス） | 80 件（新規 6 件を含む、pass 記録） |
| 冪等性 / 同時実行 / 障害注入 | 🟡 一部 | fail-open 検査と判定エラー系の単体は緑。Supabase を実際に止める実測は未実施 |
| CI（GitHub Actions） | ⬜ 未実施 | GitHub 停止中 |

## 05 何かあったらどうするか（観測・ロールバック）
- サーバーログの `proxy_admin_denial_skip:*` と `hidden_row_denial_skip`、`/admin/audit` の「拒否」タブ
- 異常: admin パスの転送が起きているのに `proxy_admin` の行が増えない
- ロールバック: revert のみ
