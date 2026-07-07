-- WHY: rls_auto_enable() / ensure_rls イベントトリガーはリモートDBには存在するが、
--      どのmigrationファイルにも記録されていなかった(db diff --linked で発覚したスキーマドリフト)。
--      新規テーブル作成時にRLSを自動でENABLEする安全装置のため、削除せずmigration化して
--      disaster recovery・新規環境構築でも再現できるようにする。
--      関数定義は pg_get_functiondef('public.rls_auto_enable()'::regprocedure) でリモートから
--      直接取得した実体をそのまま転記している(記憶からの再構成はしない)。
-- DROP EVENT TRIGGER IF EXISTS により、既にトリガーが存在するリモートでも、
-- まだ存在しないローカル/新規環境でも、どちらでも安全に適用できる。

DROP EVENT TRIGGER IF EXISTS ensure_rls;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();
