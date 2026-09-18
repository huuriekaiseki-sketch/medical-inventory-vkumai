# case-1-membership-check-on-wrong-subject（sweep-db-holdout）

## このセットは何か

**評価専用（held-out）。プロンプトやモデルの調整には使わない。**
（レビュー R11「調整に使うケースと評価専用のケースを分離」）

`sweep-db` セットは調整に使うので、そこでの数字は「良くなったように見えるだけ」の
可能性が常に残る。こちらは調整の材料にしないので、**手を入れた効果が本物かを測れる**。

## 埋め込んでいる欠陥

`SECURITY DEFINER` 関数の認可バイパス。ただし `sweep-db/case-1` とは**形が違う**。

認可チェックらしき行は**ある**:

```sql
AND EXISTS (SELECT 1 FROM user_facilities uf WHERE uf.facility_id = i.facility_id)
```

しかしこれが見ているのは「**誰かが**その施設に所属しているか」であって、
「**呼び出し元が**所属しているか」ではない。`auth.uid()` との突合が無いので、
認証済みの利用者なら誰でも他施設の `internal_note` を読める。

`SECURITY DEFINER` は RLS を通らないので、関数の中で呼び出し元を確かめないと止まらない。

## なぜこの形にしたか

「`is_facility_member` という語があるか」を grep するだけの浅い確認では **✓ に見える**。
プロンプトを語の有無に寄せて直すと、このケースは落ちる。
**言い換えでなく、本当に見るべきものを見ているか**を測るための形。

## 判定

陽性。`sterilization_logs.sql` を名指しし、認可に関する語のいずれかに触れた指摘が要る。

## 限界

- 1 件だけなので、これ 1 つで「見逃し率」を代表できるわけではない
- **一度でも調整に使ったら held-out ではなくなる**。使ったらここに日付と経緯を書く
- `user_facilities` は実在の表だが、この fixture の表は実在しない（`files/` にだけある）

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731）。

## 別の検査器はこの欠陥を見つけた（2026-09-10）

この fixture を置いた直後、Claude Code の背景セキュリティレビュー（security-guidance プラグイン）が
**HIGH**「Multi-tenant scoping bypass in SECURITY DEFINER function」として検出し、
修正案として `is_facility_member(i.facility_id)` / `uf.user_id = auth.uid()` を提示した。
**期待する正解と同じ**である。

意味するところ:

- この欠陥は「難解すぎて誰にも見つけられない」ものではない。**別の手法なら見つかる**
- したがって `sweep-db` が `case-1` を 4 回とも見逃したのは fixture の作りではなく
  **Sweep 側の手順・モデルの問題**である、という見立てを裏づける
- 検出器を比べる材料にもなる（同じ欠陥に対して、片方は HIGH、片方は「指摘なし」）

なお、この SQL は `scripts/eval-fixtures/` 配下にあり**実 DB には適用されない**
（`supabase db reset` が読むのは `supabase/migrations/` のみ。ここは eval が
使い捨ての clone へコピーするだけ）。指摘は正しいが、直すと計測が壊れるので直さない。
