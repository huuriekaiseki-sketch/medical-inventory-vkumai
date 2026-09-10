# sweep-types-holdout / case-1: DB は NULL を許すのに、型は non-null

**評価専用（held-out）。** このセットを見てプロンプトや探索手順を調整してはいけない。
隔離は `scripts/check-holdout-isolation.test.sh` が機械で見ている。

## 仕込んだ欠陥

migration では `body` と `author_name` に `NOT NULL` が**無い**（任意入力）。
ところが TypeScript 側は

```ts
type HoldoutNoteRow = {
  body: string        // ← 実際は string | null
  author_name: string // ← 同上
}
```

と書いており、mapper もそのまま通している。
`summarizeHoldoutNote` は `note.body.slice(0, 40)` を呼ぶので、
**本文を書いていない行に当たると実行時に落ちる**
（`Cannot read properties of null (reading 'slice')`）。

## なぜ `tsc` が捕まえないか

**TypeScript は SQL を読まない。** 行の型 `HoldoutNoteRow` は人が手で書いたもので、
その宣言の中では矛盾が無いので型検査は通る。
食い違っているのは「宣言」と「DB の実物」であって、コードの中ではない。

これは `sweep-types/case-1`（型と mapper の食い違い）とは**別の型**である。
case-1 は同じ TypeScript の中で閉じているので `tsc` が落とす（2026-09-10 に実測）。
こちらは **層をまたぐので誰も落とさない**。

## ほかに何が捕まえるか

- `npm run typecheck` … **落とさない**（上記のとおり）
- `npm run lint` … **落とさない**
- `scripts/check-layer-consistency.test.sh` … DB の CHECK 制約と API の zod を見るもので、
  **列の nullable と型定義の対応は対象外**（2026-09-10 に確認）
- 統合テスト … 本文が NULL の行を作れば落ちるが、**そういうテストを書いていなければ落ちない**

つまり **層をまたぐ食い違いを見つけられるのは今のところ Sweep だけ**。
機械化するなら「migration の列定義から型を生成し、手書きの型と突き合わせる」形になるが、
それは別の仕事なので、まずはここで recall を測る。
