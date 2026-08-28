-- issue #675: 短貸返却(loan_return)の二重登録を防止する
-- WHY: create_loan_return_atomic RPCはloan_returns.loan_order_idを保存するが、
--      この列にUNIQUE制約が無いため、同じloan_order_idに対して返却登録を2回実行すると
--      loan_returnsに重複行が作られてしまう。DB制約による最終防御として部分UNIQUEインデックスを追加する。
--      loan_order_idはNULL許容のFKであり、大多数の既存行はNULLのまま（対象を選ばない返却は
--      従来通り無制限に複数回登録できる）。部分インデックスでNULLを除外することで、
--      「NULL同士は不一致」というPostgresのUNIQUE制約の挙動に依存せず意図を明確にする。
CREATE UNIQUE INDEX loan_returns_loan_order_id_unique
  ON loan_returns (loan_order_id)
  WHERE loan_order_id IS NOT NULL;
