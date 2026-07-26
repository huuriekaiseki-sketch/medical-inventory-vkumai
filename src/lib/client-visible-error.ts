// WHY: repository層が投げるErrorのうち「翻訳済みで安全にクライアントへ見せてよいメッセージ」だけを
//      区別するためのマーカークラス。api-error.tsのtoClientErrorMessageはこのクラスのインスタンスの
//      messageだけをそのまま返し、それ以外(生のPostgres/Supabaseエラー等)はサニタイズする
//      (architecture review 2026-07-26 issue #3: raw error.messageのDBスキーマ情報漏洩対策)
export class ClientVisibleError extends Error {}
