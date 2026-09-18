# 2026-09-18 設定ドリフト検知（issue #757 の 35 の手元側）

## 30秒サマリー
- 変更概要: migration から導いた「こうなっているはず」と実 DB の権限・RLS ポリシーを突き合わせ、PR を通さない変更を見つける
- リスク: 中（migration を 1 本足すが、読み取り専用の関数 1 つ。既存の表・列・関数は変えない）
- 変更領域: DB（関数追加）/ 検査 / 生成物 / docs
- 証拠状態: 実測 8 件（端から端までの突合・ドリフト検知の実測 2 種・回帰テスト 16 項目・統合 377・単体 2295・lint・tsc・hooks-test 通し）/ 未検証 1 件（CI）
- 影響範囲: 製品の動きは変わらない（アプリはこの関数を呼ばない）
- ロールバック可能性: 高（`DROP FUNCTION public.config_snapshot()` と revert）

レビューしてほしい点:
1. `config_snapshot()` を **SECURITY DEFINER にしなかった**判断（pg_catalog は PUBLIC が読めるので不要）
2. 期待値に**プラットフォーム既定**を含める判断（下記「前提が崩れていた」）

## 00 目的・影響範囲・対象外
- 目的: 「ダッシュボードや SQL Editor で権限を足した」をリポジトリ側から見つける
- 対象外: **本番 / staging への接続**（外部待ち。`CONFIG_DRIFT_URL` / `CONFIG_DRIFT_KEY` で差し替えられる形だけ作った）/ GitHub のブランチ保護（#757 の 6 と一体）/ Storage policy（機能が無い）
- 依存の変更: **なし**（`pg` 等を足さずに済ませるため、関数 + 既存の supabase-js 経路にした）

## 前提が崩れていた（調査で分かったこと）

issue は「migration と `.env.example` から作った期待値」と書いていたが、**両方とも成り立たなかった**。

1. **`.env.example` が存在しなかった**（あるのは `.env.test.example`）。→ 生成物として作った（`process.env.*` の走査。名前だけ、値は書かない）
2. **migration だけでは実 DB の権限を再現できない**。Supabase の `public` には既定権限があり、`postgres` が作った表には anon / authenticated / service_role へ `Dxtm` が自動で付く（`pg_default_acl` で実測）。足さないと**実在する権限を「余分」と誤検知する**

## 実測でしか見つからなかった誤り 5 件

**期待値だけ作って比較を書かなければ、5 件すべてが残ったまま「動くつもりの検査」になっていた。**

| # | 誤り | 症状 |
| --- | --- | --- |
| 1 | `ALTER DEFAULT PRIVILEGES` の判定が本文全体を見ていた | 「使っていない」と説明するコメントを拾い、実在しない注意が 5 件 |
| 2 | `ALL` の展開に `MAINTAIN`（PG17 の権限）が無い | `REVOKE ALL` 後に MAINTAIN だけ残り、**25 件の嘘の差分** |
| 3 | 関数識別子の形式差（引数名つき vs 型のみ） | 関数の権限が 41 対 33 で**全滅** |
| 4 | **動的 DDL（DO ブロック内の GRANT）を黙って飛ばしていた** | 4 件の嘘の「PR を通さない変更の疑い」。**自分で C-044 と書いた穴に自分で落ちた** |
| 5 | 固有語の確認を 3 語（vkumai/medical/inventory）だけでやった | 禁止語には `supabase` と `facility` もあり、**共通側へ配ろうとして止められた**（正しくはアダプター側） |

4 は `replay-rls-policies.mjs` が先に解いていた問題と同じ型。5 は自分の目視より機械の禁止語検査のほうが正確だった。

## 02 内部でどう守っているか
- `supabase/migrations/20260918000000_add_config_snapshot.sql`: `public.config_snapshot()`。
  **SECURITY DEFINER を付けない**（読むのは `pg_catalog` と `pg_policies` だけで PUBLIC が読める）。
  `information_schema.role_table_grants` は**自分に関係する行しか返さない**ので使わず `pg_class.relacl` を読む。
  EXECUTE は service_role のみ（権限の一覧は攻撃者にとって地図になる）
- `scripts/lib/replay-grants.mjs`: GRANT/REVOKE を順に再生。動的 DDL を展開し、関数の署名を追い、
  **読めない行は黙って飛ばさず名指しする**
- `scripts/check-config-drift.sh`: 差分が無ければ黙り、あれば名指しして落ちる。
  **繋げないときは「確認不能」と言って合格にしない**

## 03 誰が操作できるか
- RLS・権限の変更: 新しい関数 1 つへの EXECUTE（service_role のみ）。既存の権限は変えていない
- 他テナントの ID での確認: 不要（この関数は業務データを返さない）

## 04 どう確認したか

| 種別 | 状態 | 結果・証跡 |
| --- | --- | --- |
| **端から端までの突合** | ✅ 実施（手動） | 期待値と実 DB が 3 分類すべて一致（表 47 / 関数 33 / ポリシー 35） |
| **ドリフト検知の実測** | ✅ 実施（手動） | `GRANT SELECT ON audit_log TO anon` → 名指しで検知。`DROP POLICY access_denials_select` → 名指しで検知。`bash scripts/check-config-drift.sh` が exit 1 |
| **確認不能の実測** | ✅ 実施（手動） | migration の無い接続先へ向けたとき「確認不能」と言って exit 0（合格にしない） |
| hook 回帰 | ✅ 実施（自動テスト: パス） | `check-config-drift.test.sh` 16 項目。CI の hooks-test と同じ並びで通して落ちた検査 0 件 |
| RLS/IDOR 統合（実 DB） | ✅ 実施（自動テスト: パス） | 49 files / 377 tests。新 migration 込みで回帰なし |
| unit | ✅ 実施（自動テスト: パス） | 248 files / 2295 tests |
| 型検査 / lint | ✅ 実施（自動テスト: パス） | exit 0 / 警告 0 |
| CI | ⬜ 未実施 | PR で初めて回る |

## 05 何かあったらどうするか
- 使い方: `bash scripts/check-config-drift.sh`（既定はローカル）。本番へ向けるときは `CONFIG_DRIFT_URL` / `CONFIG_DRIFT_KEY`
- 異常の判断基準: **「実環境にあるが期待に無い」がいちばん危ない**（PR を通さない変更の疑い）
- ロールバック: `DROP FUNCTION public.config_snapshot()` と revert

## 後任AIへの注意
- **期待値は migration だけでは作れない。** Supabase の既定権限（`Dxtm`）を足す。値は 2026-09-18 の実測なので、Supabase 側が変えたら差分として出る
- **`ALL` の展開に `MAINTAIN` を入れる**（PG17）。忘れると `REVOKE ALL` の後に残りかすが出る
- **動的 DDL を飛ばさない。** DO ブロックの中の `format('GRANT ...')` も再生する
- **この検査は Supabase 固有。** 共通側（aidd-core）へは配れない（禁止語に `supabase` がある）
- `generatedFrom` の件数は**生成物の鮮度を見るためのもの**。手で書き換えない（`bash scripts/build-config-expected.sh`）

## ハーネスの成績（この issue で起きたこと）

- **禁止語検査が止めた**: 共通側へ配ろうとしたのを `supabase` / `facility` で止め、正しい層（アダプター側）へ導いた
- **配布の網羅検査が止めた**: `checkScopes` にだけ書いて配布層を書いていない状態、支援スクリプト 2 本の未登録を名指しした
- **実 DB との突合そのものが止めた**: 上の表の誤り 5 件のうち 2・3・4 は、比較を走らせなければ緑のまま残っていた
