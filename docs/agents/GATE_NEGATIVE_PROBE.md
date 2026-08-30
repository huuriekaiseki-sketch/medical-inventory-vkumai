# CIゲートの negative 検証用の一時ファイル

integration-gate.yml の `paths` フィルタが、**対象外のパスでは発火しない**ことを
確かめるためだけに置いた一時ファイル。確認後に削除する。

このファイルは `docs/agents/` 配下であり、ゲートの対象パス
（`supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・
`**/middleware.ts`・`.github/workflows/integration-gate.yml`）のいずれにも該当しない。
したがって、このファイルだけを変更したPRでは `integration` ジョブが**現れないはず**。
