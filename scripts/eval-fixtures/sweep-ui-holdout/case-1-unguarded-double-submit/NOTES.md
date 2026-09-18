# sweep-ui-holdout / case-1: 送信中のガードが無いフォーム

**評価専用（held-out）。** このセットを見てプロンプトや探索手順を調整してはいけない。
調整に使った時点で、ここで出る点は「過学習した結果」になる。
隔離は `scripts/check-holdout-isolation.test.sh` が機械で見ている
（名前が `.claude/` 配下へ漏れていないこと）。

## 仕込んだ欠陥

`ConsumableRegisterForm` は `onRegister` の完了を `await` するが、
**その間ボタンを押せたままにしている**。

- 送信中を表す state が無い（`isSubmitting` 等）
- `<button type="submit">` に `disabled` が無い

利用者が「登録」を連打すると、同じ品目が**行の数だけ**登録される。
在庫の数が合わなくなり、後から手で消すしかない。

## なぜ既存の case と別の型か

`sweep-ui/case-1` と `case-2` はどちらも `useSearchParams` の Suspense 漏れで、
**同じ型を 2 回測っている**。held-out はそれとは別の型
（非同期の完了を待つ間の UI 状態）にしてある——
同じ型ばかりを測ると「その型だけ見つけられる」状態を見逃す。

## ほかに何が捕まえるか

- `npm run typecheck` … **落とさない**（型としては正しい）
- `npm run lint` … **落とさない**（React の規則には違反していない）
- `next build` … **落とさない**
- 機械の検査 … **無い**（「送信中に押せるか」を静的に見る検査はこのリポジトリに存在しない）

つまり **今のところ Sweep（と人のレビュー）しか見つけられない層**。
だからこそ held-out として recall を測る意味がある。
