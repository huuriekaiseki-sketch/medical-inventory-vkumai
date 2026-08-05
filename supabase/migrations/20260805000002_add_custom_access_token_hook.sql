-- supabase/migrations/20260805000002_add_custom_access_token_hook.sql
-- WHY: Supabase学習ロードマップの「JWT Custom Claims / Custom Access Token Hook」の
--      ハンズオン。user_facilitiesのroleを集約した`user_role`クレームをJWTへ
--      埋め込む。これにより、クライアント側でセッションのJWTをデコードするだけで
--      「グローバルにどのroleを持っているか」が分かるようになり、都度RPCへ
--      問い合わせなくて済む場面を作れる。
--
-- WHY(既存middleware.tsのadmin判定には反映しない): admin判定は現状
--      resolveIsAdmin()(DB role + ADMIN_EMAILSフォールバックの二重登録防止ロジック)
--      に依存しており、このフォールバックとDB roleの乖離自体が別issue(#567
--      「管理者判定のtruthをDB roleへ統一する」)として追跡中。このhookの追加を
--      理由にmiddleware側の実装を差し替えると、#567の論点を素通りして
--      セキュリティ境界を変えることになるため、今回はhookとclaimの追加のみに
--      とどめ、実際の認可判定の切り替えは行わない。
--
-- WHY(SECURITY DEFINERが必要な理由・実機検証で判明): user_facilitiesのRLSポリシー
--      "self_read"はTO authenticatedのみが対象で、supabase_auth_adminにはSELECT権限
--      をGRANTしてもRLSが対象ロール外として全行を隠してしまう(supabase_auth_admin
--      はrolbypassrls=false)。SECURITY DEFINERなしで実装し実際にログインさせたところ
--      GoTrueから"output claims do not conform to the expected schema: (root):
--      Invalid type. Expected: object, given: null"という500エラーになることを確認した。
--      SECURITY DEFINERにして関数所有者(postgres、テーブルオーナーのためRLSをバイパス)
--      として実行させることで解消する。呼び出し可能なロールをsupabase_auth_adminのみに
--      REVOKE/GRANTで厳格に絞っているため、SECURITY DEFINERによる権限昇格の範囲は
--      「auth hookとしてのみ・claims生成目的のみ」に限定される
--      (docs/agents/known-failure-patterns.md「SECURITY DEFINER + GRANT EXECUTEの
--      認可バイパス」に該当する誤用ではない。任意の認証ユーザーからは実行不可)。
--
-- WHY(coalesce(to_jsonb(v_role), 'null'::jsonb)が必要な理由・実機検証で判明):
--      to_jsonb(NULL::text)はJSON null('null'::jsonb)ではなくSQL NULLを返す。
--      jsonb_setはSTRICT関数のため、new_value引数にSQL NULLを渡すと関数全体がNULLを
--      返し、eventがまるごとNULLになる(施設未所属でv_roleがNULLになるケースで発生、
--      実機で発見。COALESCEでJSON null literalに変換してから渡す)。
--
-- WHY(user_roleクレームの用途をUIゲーティング専用に限定する・issue #610):
--      bool_orによる集約は施設ごとのロール差を捨象する。施設Aのみadminで施設Bでは
--      staffのユーザーの場合、このクレームは「admin」を返すが、それは施設B文脈での
--      権限を意味しない。そのためこのクレームは表示/非表示等のUIゲーティングにのみ
--      使い、認可判断には使わないこと。認可はRLS/RPCが引き続きauth.uid()から
--      user_facilitiesを都度引き直して施設ごとに再判定するため、このクレームの
--      曖昧さは認可結果に影響しない(前提・再検証条件はdocs/agents/decisions/db-rls.md
--      「なぜJWTのuser_roleクレームをUIゲーティング専用に限定したか」を参照)。

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (event->>'user_id')::UUID;
  v_role TEXT;
BEGIN
  SELECT
    CASE
      WHEN bool_or(role = 'admin') THEN 'admin'
      WHEN bool_or(role = 'staff') THEN 'staff'
      WHEN bool_or(role = 'viewer') THEN 'viewer'
      ELSE NULL
    END
  INTO v_role
  FROM public.user_facilities
  WHERE user_id = v_user_id;

  event := jsonb_set(event, '{claims,user_role}', COALESCE(to_jsonb(v_role), 'null'::jsonb));

  RETURN event;
END;
$$;

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, PUBLIC;
