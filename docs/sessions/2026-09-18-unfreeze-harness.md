# 2026-09-18 ハーネス凍結（H-014）を解除する

`docs/agents/harness-freeze.md` を削除し、commit-msg hook の凍結判定を無効にした。
**この文書が凍結の顛末の正本**（マーカーを消した以上、元ファイルは HEAD に無い）。

## 何だったか

2026-09-11 の外部レビューで「ハーネスの育成は終わり、製品 issue で『止めた / 見逃した / 邪魔した』を
記録する証明フェーズへ移る」と決めた。決めた後の 48 コミットのうち製品コードに触れたのは 1 件で、
cardiosearch の「6 日 239 コミット中 src/ が 1.3%」と同じ形に入っていた。

人の決意は 2 日で消えたので、2026-09-13 に決めごとをコミットの入口へ移した（`scripts/git-hooks/commit-msg`）。
**HEAD に `docs/agents/harness-freeze.md` がある間**、`src/` `supabase/` `e2e/` に 1 ファイルも
触れないコミットを止める仕組み。

## 解除の条件と、それを満たした根拠

条件は「製品 issue 3 本について、issue ごとにハーネスの成績を 1 行ずつ記録し終えたとき」。

| # | issue | PR | 内容 | 記録 |
| --- | --- | --- | --- | --- |
| 1 | #757-24 | #777 | proxy の /admin 拒否と RLS 不可視行への直指定を access_denials に残す | `docs/sessions/2026-09-13-record-proxy-admin-denial.md` |
| 2 | #757-16 | #778 | CSP を nonce ベースへ広げ script-src を絞る | `docs/sessions/2026-09-18-csp-nonce.md` |
| 3 | #757-3 | #780 | 状態の語彙の CHECK を残り 4 表で実測 | `docs/sessions/2026-09-18-invariant-status-checks.md` |

`docs/agents/harness-score.jsonl` は 23 行。3 本すべてについて行がある。

## 仕分けの結果（`node scripts/lib/check-harness-score.mjs --summary`、2026-09-18 時点）

- **keep 10 件**: Coverage Check / docs 整合性検査 / Manifest Check / セッションメモの形式検査 /
  E2E（Set G）/ 約束カタログ検査 / service_role 宣言検査 / 不変条件カタログ検査 /
  RED 方向の実測 / Next.js ドキュメント参照ルール。**ほとんどが費用ゼロで止めている**
- **drop 7 件（合計 67 分の空振り）**: うち 47 分が深掘り Phase 1（30 分）と Phase 2（17 分）。
  この 3 本では一度も止めていない
- **fix-or-drop 5 件**: git hook（**missed 2 回**）/ 4 観点レビュー / 仕様書の統合提案 /
  統合担当の完了報告 / route テスト（既存）

## この数字で v1.x の削除を決めない（限界）

- **サンプルが 3 本しかない。** 「何も起きなかった部品は書かない」規則なので、`drop` の部品も
  「たまたまこの 3 本で出番が無かった」だけかもしれない
- **3 本の性質が偏っている。** 記録の追加・設定変更・テスト追加で、AIDD パイプラインが想定する
  「高リスクな新機能開発」は 1 本も無い
- `harness-score.md` の「限界」節のとおり、行の中身が本当に起きたことかは機械で見ていない

**次に決めるときは、性質の違う製品 issue（新機能・DB スキーマ変更）を何本か通してから読む。**

## 凍結中に分かった、凍結そのものより重い問題

`git hook（commit-msg / pre-push）` が**この 3 本で 2 回 missed**（唯一の複数回）。
どちらも同じ原因で、worktree の `config.worktree` にある `core.hooksPath` の上書きが
実在しないディレクトリを指し、**git がそれを黙って無視する**（E-092）。

2026-09-13 に発見・記録し、`harness-freeze.md` の「限界」節に手で確認する手順まで書いたのに、
**2026-09-18 に同じ worktree で再発**した。そのセッションの CI 修正 4 件は H-014 を素通りしている。

**凍結を解いても、この穴は残る。** 機械検知は別 issue として起票済み。

## 解除後にできるようになること

`scripts/` と `docs/` だけのコミットが通る。`#757-35`（設定ドリフト検知の手元側）のような
製品コードを伴わない作業が再開できる。

**再び凍結したくなったら**、`docs/agents/harness-freeze.md` を作るコミットを入れるだけでよい
（hook 側の判定は消していない。`scripts/check-git-hooks.test.sh` の scenario 8 が
一時リポジトリで仕組みを検査し続ける）。
