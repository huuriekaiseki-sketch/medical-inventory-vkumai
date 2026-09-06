// WHY: issue #757 の 24。拒否の記録（access_denials）に「どの経路か」を残すため、
//      proxy が転送リクエストへパスとメソッドを付け、Route Handler 側のガードがそれを読む。
//      Route Handler は自分のパスを知る手段を持たないので、proxy が渡すしかない。
//
// WHY(このファイルを分けた): proxy は Edge Runtime で動く。記録本体
//      （src/lib/security/access-denial.ts）は service role キーを参照するので、
//      proxy から import すると Edge のバンドルに入ってしまう。名前だけを持つこのファイルなら
//      どちらからも安全に読める。
//
// WHY(必ず上書きする): クライアントが同じ名前のヘッダを送ってきても proxy が毎回上書きする。
//      証跡に偽の経路を書かせないため。

export const DENIAL_ROUTE_HEADER = 'x-aidd-route'
export const DENIAL_METHOD_HEADER = 'x-aidd-method'
