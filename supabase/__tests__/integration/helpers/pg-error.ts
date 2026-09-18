// supabase/__tests__/integration/helpers/pg-error.ts
//
// WHY(2026-09-09 に実測して分かった): PostgREST は **権限が無い場合も、RLS のポリシーに
//      落ちた場合も同じ `42501`** を返す。コードだけで判定すると、
//      「権限を剥がしただけ」の変更を「RLS が守っている」と読み違える（C-023 の形）。
//      層を見分けられるのは**文言**だけなので、判定を 1 か所に集める。
//
//        権限が無い     : permission denied for table <t>
//        RLS で落ちた   : new row violates row-level security policy for table <t>
//
//      なお UPDATE / DELETE が RLS に落ちたときは**エラーにならず 0 行**になる。
//      「拒否」と「0 行」を混同しないこと（RLS は拒否ではなく 0 行にする）。

/** Supabase のエラーの、この判定に要る部分だけ */
export interface PgErrorLike {
  code?: string | null
  message?: string | null
}

const PERMISSION_DENIED = 'permission denied for table'
const RLS_REJECTED = 'violates row-level security policy'

/** 権限（GRANT）そのものが無くて拒まれたか */
export function isPermissionDenied(error: PgErrorLike | null | undefined): boolean {
  return error?.code === '42501' && (error.message ?? '').includes(PERMISSION_DENIED)
}

/** 権限はあるが RLS のポリシー（WITH CHECK）で拒まれたか */
export function isRlsRejected(error: PgErrorLike | null | undefined): boolean {
  return error?.code === '42501' && (error.message ?? '').includes(RLS_REJECTED)
}

/** 失敗メッセージ用に、どちらでもない拒否をそのまま見せる */
export function describeDenial(error: PgErrorLike | null | undefined): string {
  if (!error) return '拒否されなかった（成功した）'
  return `${error.code}: ${error.message}`
}
