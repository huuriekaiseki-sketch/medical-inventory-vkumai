# 2026-09-13 record-proxy-admin-denial（#757-24 の残り。ハーネス証明フェーズの 1 本目）

## 30秒サマリー
- 変更概要: proxy が `/admin` `/api/admin` を弾いて `/login` へ跳ね返す拒否を `access_denials` に残す（guard=`proxy_admin`）
- リスク: 高（proxy.ts・auth 境界・拒否の証跡）
- 変更領域: ロジック（proxy / Server Component）・テスト・docs。DB・RLS・migration は無変更
- 証拠状態: 実測 12 件（unit・統合・E2E・build・tsc・lint・hook 回帰・直接攻撃 5 種・docs 整合性・秘密走査・依存監査・生成型）/ サンプル・未検証 1 件（CI。GitHub 停止中）
- 影響範囲: `/login` の内部構造（Server Component の皮＋既存フォーム）。見た目・ログイン体験は無変更
- ロールバック可能性: 高。migration 無し。このブランチのコミットを revert するだけ

レビューしてほしい点:
1. 「印（cookie）は偽造できるが actor_id はセッション由来」という限界の受け入れ（Part 1 の設計判断）
2. 実装中に E2E で見つかった Next.js の挙動（応答で cookie を消すと同じリクエストの `cookies()` にも反映される）への対処＝ヘッダへの載せ替え

## 00 目的・影響範囲・対象外
- 目的: P-063 の限界欄にあった「proxy が /login へ返す admin 経路は未記録」を塞ぐ
- 変更範囲: `src/proxy.ts`、`src/lib/security/denial-headers.ts`、`src/app/login/page.tsx`（新設: Server Component）、`src/app/login/LoginForm.tsx`（旧 page の中身を移動）、`src/lib/security/access-denial.ts`（コメント）、テスト 4 本、`e2e/admin-audit.spec.ts`、docs 4 本
- 対象外（今回あえて触らない）: `/api/admin/*` の API 呼び出しが HTML の `/login` へ転送される既存挙動、RLS の黙った 0 件、MFA 未昇格の非 admin（MFA ガードが先に止めるため未記録。F-005 に明記）
- 作業中に見つけた別件: `/admin/audit` の拒否理由ラベルに `aal2_required` が無く生文字列で出る（1 行修正。人間判断で別コミットへ）。`.claude/worktrees/remaining-tasks-check-f3afd7` の `config.worktree` に hooksPath の絶対パス上書きがあり hook が一度も動いていなかった（本ブランチの 1 つ前のコミット e5919578 で修正済み）
- 依存の変更: なし

## 01 画面がどう変わったか（UI証拠）
- 対象外（見た目・操作の変更なし。`/login` は Server Component の皮を被せただけで、フォームの中身は無変更）

## 02 内部でどう守っているか（ロジック証拠）
- proxy: `isAdminPath` の判定を未認証ガードより前に上げ、admin パスへの未認証・非 admin の転送応答に httpOnly cookie の印（理由・経路・メソッド）を載せる（`src/proxy.ts` `redirectWithDenial`）
- proxy: `/login` に印付きで来たら、印の中身を転送リクエストの `x-aidd-denial` ヘッダに載せ替え（クライアントが同名ヘッダを送っても必ず上書き・無ければ削除）、応答で cookie を消す
- Server Component（`src/app/login/page.tsx`）: ヘッダを読み、zod で形を検証し、`reason='not_admin'` のときだけセッションから actor_id を取って `recordAccessDenial({guard:'proxy_admin', …})` を呼ぶ。3 層とも fail-open（表示は止めない）、判定は fail-closed のまま
- **なぜ cookie を直接読まないか**: 応答で cookie を消すと Next.js は同じリクエストの `cookies()` にも削除を反映する（`node_modules/next/dist/server/async-storage/request-store.js` の x-middleware-set-cookie）。最初の実装は cookie を読んでいて、単体テストはモックで緑・レビュー 4 観点も緑のまま、E2E で「記録 0 件」が出て発覚した

## 03 誰が操作できるか（RLS/権限証拠）
- RLS・権限の変更点: なし。`record_access_denial()` の EXECUTE は service_role のみ、`access_denials` の SELECT は aal2 の admin のみ（既存）
- 他テナントの ID でアクセスし弾かれることの確認: 直接攻撃の実測（04 の「直接攻撃」行）。偽の `not_admin` はセッションが無いと記録されず、偽の `unauthenticated` は actor_id NULL の匿名行にしかならない。偽ヘッダは proxy が削除。201 文字の経路は不記録
- 該当する約束: P-063（限界欄を更新）。新しい約束は作っていない

## 04 どう確認したか（テスト・検証）
| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 | ✅ 実施（自動テスト: パス） | `npx tsc --noEmit` 0 errors（2026-09-13 17:xx JST） |
| lint | ✅ 実施（自動テスト: パス） | `npm run lint` 警告 0 |
| unit（UI・データ層・API Route） | ✅ 実施（自動テスト: パス） | `npm test` 245 files / 2,244 件（ヘッダ方式への修正後） |
| build | ✅ 実施（自動テスト: パス） | `npm run build` exit 0 |
| migration 静的テスト | ✅ 実施（自動テスト: パス） | `npm test` に含む（migration は無変更） |
| DB 制約 ratchet | ✅ 実施（自動テスト: パス） | `npm test` に含む |
| PII のログ流出検査 | ✅ 実施（自動テスト: パス） | lint（no-console）＋ hook 回帰の `check-pii-leak.test.sh` |
| 秘密情報の走査 | ✅ 実施（自動テスト: パス） | `check-secret-leak.test.sh` ALL PASSED（一時的に置いたデモ鍵入り launch.json を戻した後に実行） |
| セキュリティヘッダ | ✅ 実施（自動テスト: パス） | `npm test` に含む |
| 時刻・タイムゾーン | ✅ 実施（自動テスト: パス） | `npm test` / lint に含む |
| ワークフロー同期テスト | ✅ 実施（自動テスト: パス） | `npm test` に含む |
| hook 回帰 | ✅ 実施（自動テスト: パス） | `scripts/*.test.sh scripts/lib/*.test.sh` 全件（CI の hooks-test と同じ並び）。初回 148/150（約束カタログの ID 未記載・空テンプレのセッションメモ）→ 落ちた 2 本を修正後に再実行して合格（残り 148 本は初回の合格をそのまま採用。その後に触ったのはテストの describe 名とこのメモだけで、影響する docs 整合性・制御バイト走査は再実行して合格） |
| 認証ファイル漏洩チェック | ✅ 実施（手動） | `git ls-files e2e/.auth` → `.gitkeep` のみ |
| 依存監査（既知脆弱性） | ✅ 実施（自動テスト: パス） | `npm audit --omit=dev --audit-level=high` 0 vulnerabilities |
| ロックファイルの出所 | ✅ 実施（自動テスト: パス） | hook 回帰に含む（`check-lockfile-integrity.test.sh`） |
| docs 整合性 | ✅ 実施（自動テスト: パス） | 初回に P-063 のテスト列の誤パス（`src/proxy.test.ts`）を検知 → 修正後 70 本 違反なし |
| ルールを守る検査の有無 | ✅ 実施（自動テスト: パス） | `check-rule-guard-coverage.mjs` 15 節 違反なし |
| ルールを守る検査が効いているか | ✅ 実施（自動テスト: パス） | hook 回帰に含む（`check-rule-guard-effective.test.sh`） |
| ロードマップの状態の鮮度 | ✅ 実施（自動テスト: パス） | `check-roadmap-staleness.mjs` 要見直し 0 |
| 棚卸し表の行の重複 | ✅ 実施（自動テスト: パス） | `check-table-row-duplicates.mjs` checked=5 violations=0 |
| RLS/IDOR 統合（実 DB） | ✅ 実施（自動テスト: パス） | `npm run test:integration` 49 files / 373 件（1 skip）。`logs/integration-runs.jsonl` に pass 記録 |
| 生成型の鮮度 | ✅ 実施（自動テスト: パス） | `check-generated-supabase-types.sh` up to date |
| 直接攻撃の実測（テスト外） | ✅ 実施（手動） | ローカル dev サーバー＋ローカル Supabase に対し: A) 未ログイン /admin → 307・HttpOnly・Path=/login・Max-Age=10 の印 / B) 偽 `x-aidd-denial` ヘッダ直送 → 記録 0 / C) 偽 cookie（not_admin）→ 記録 0（セッション無しでスキップ） / C') 偽 cookie（unauthenticated）→ 記録 +1・actor_id NULL / D) route 201 文字 → 記録 0 / E) 印付き /login → 応答で Max-Age=0。攻撃表の spec（P-017）も E2E 本走に含む |
| E2E（Playwright） | ✅ 実施（自動テスト: パス） | `npm run test:e2e` 77 件（新規 3 件を含む）。`logs/e2e-runs.jsonl` に pass 記録。初回は 2 件失敗（本物のバグ 1・テストの書き方 1）、修正後に本走で合格 |
| 障害注入（外部依存停止） | 🟡 一部 | `check-fail-open.test.sh` ALL PASSED、`proxy.test.ts` の判定エラー系は緑。Supabase を実際に止める実測は未実施（記録の 3 層は既存の握りつぶし設計を踏襲し、判定経路は変えていない） |
| 依存差分レビュー | ➖ 今回不要 | package.json / package-lock.json に触れていない |
| agents baseline 鮮度 | ➖ 今回不要 | .claude/agents・.claude/workflows に触れていない |
| ワークフロープロンプト eval | ➖ 今回不要 | .claude/workflows に触れていない |
| hook 実機発火 | ➖ 今回不要 | hook スクリプト・.claude/settings.json・.codex/hooks.json に触れていない |
| 冪等性（再送・二重実行） | ➖ 今回不要 | 注文・返却系の RPC / 作成 route に触れていない |
| 業務不変条件（DB 制約） | ➖ 今回不要 | migration・不変条件カタログに触れていない |
| 同時実行 | ➖ 今回不要 | 同一行を複数ユーザーが更新する変更ではない |
| CI（GitHub Actions） | ⬜ 未実施 | GitHub アカウント停止中で PR・CI が使えない。上の各行はローカルで CI と同じコマンドを回した実測 |

- この変更に直接対応するテスト: `src/__tests__/proxy.test.ts`「拒否記録用の印（httpOnly cookie） [P-063]」（7 件＋偽ヘッダ削除 1 件）、`src/app/login/__tests__/page.test.tsx`（7 件）、`src/lib/security/__tests__/denial-headers.test.ts`、`e2e/admin-audit.spec.ts`「proxy の admin 拒否が access_denials に記録される」（3 件）
- fault injection: 未実施（上の 🟡 のとおり）
- 上の数値はすべてこのセッションのツール結果から転記した実測。verify-claims は未実施

## 05 何かあったらどうするか（観測・ロールバック）
- リリース後に見るログ/メトリクス: サーバーログの `proxy_admin_denial_skip:*`（記録をスキップした理由: `header_unreadable` / `payload_invalid` / `session_unavailable`）と `record_access_denial` のエラー。`/admin/audit` の「拒否」タブで `管理画面の入口` の行
- 異常の判断基準: admin パスの転送が起きているのに `proxy_admin` の行が増えない（記録経路の断絶）。`route` が 200 文字近い行や制御文字を含む行（parse を抜けた偽造）
- ロールバック手順: このブランチのコミットを revert。DB の変更は無い

## ハーネス証明フェーズの記録（issue 1 本目）

| 区分 | 内容 |
| --- | --- |
| 止めた | Manifest Check（deny-by-default）が run-manifest 不在で Phase 2 を止めた（承認記録なしの実装を防いだ） |
| 止めた | Coverage Check が「6 セット中 5 セット未実装」を名指しし、統合担当が拾った |
| 止めた | **E2E（Set G）が本物のバグを捕まえた**: Server Component が cookie を読む設計は Next.js の挙動で常に 0 件になる。単体（モック）とレビュー 4 観点は緑だった |
| 止めた | docs 整合性が P-063 の誤パスを検知。約束カタログ検査が新テストの `[P-063]` 欠落を検知。セッションメモ検査が空テンプレを検知 |
| 見逃した | 4 観点レビュー（correctness / coverage / redundancy / type-safety）が cookie 削除の先回りを見逃した |
| 見逃した | 統合担当が「E2E green」と報告したが、本走で 2 件失敗した（`created_at` の列名違い・`browser.newContext()` の storageState 継承）。**完了報告の主張は検証されていなかった** |
| 見逃した | 統合提案（synthesize）の critical / important 11 件のうち 3 件（1-4・1-5・1-6）は技術的に成り立たない提案で、人が実読して却下した |
| 邪魔した | 並列実装 4 体（db / data / api / ui）は担当パスが固定で、`src/proxy.ts` と `src/app/login/` はどの範囲にも入らず全員が「範囲外」で終了。1 波ぶんの時間とトークンが空振り |
| 邪魔した | run-manifest はフローが作らず人が作る前提で、Phase 2 を 1 回起動し直した |
| 邪魔した | gap check の state が Stop hook で途中クリアされ、Phase 2 本走の expected（11 / 12）を記録できなかった（gap check は Phase 1 と Phase 2 の初回分のみ実施） |
| 邪魔した | `.env.local` を読む dev サーバー（preview）はリモート向きで、直接攻撃の 1 回目が別 DB に対して走った（PGRST202 で気づいた）。ローカル向けの起動は launch.json への一時追記で行った |
| 費用 | Phase 1: 72 エージェント・30 分・543 万トークン。Phase 2: 13 エージェント・16.5 分・85 万トークン（＋blocked の 1 回 30 秒） |

## 追記（同日）: 2 本目の候補調査で見つけた実害 — admin × facility_id 省略で一覧 5 route が 500

- **見つけ方**: 残り 2 候補（RLS の黙った 0 件・読み取り監査）の可否調査で読み取り経路を棚卸しした際、
  一覧 GET の `requireFacilityAccess` が admin を通した後に `facilityId` が undefined のまま repository へ渡る
  形を発見。一時 spec で実測し、case-orders / loan-orders / consumable-orders / loan-returns / consumables が
  **500**（`invalid input syntax for type uuid: "undefined"`）、/api/orders は 400、hospital-prices / news は
  200（全施設）と、同じ状況で 3 通りだった
- **直し方（人間判断: 1）**: `requireFacilityAccess` に `facilityIdRequired` オプションを足し、admin でも
  `facility_id` 無しは `FACILITY_ID_REQUIRED`（既存の catch で 400）。5 route がそれを渡す。判定は 1 か所。
  admin の付け忘れは拒否ではないので access_denials には残さない。hospital-prices / news は変更なし（P-002 の
  「admin は施設指定なしでも通る」はそちらの契約として残す）
- **TDD**: 6 ファイルに RED を先に書き（ヘルパー 4 件・route 5 件）、6 本落ちるのを見てから実装 → 81 件緑。
  実機の再測定で 5 route とも 400、/api/orders 400、hospital-prices / news 200 のまま
- **AIDD フローを通さなかった**: 1 ヘルパー＋同型 1 行 × 5 route の範囲に対し深掘り（72 エージェント・30 分）は
  見合わないと判断し、H-005 として `logs/manual-overrides.jsonl` に理由を記録した
- **検証（この修正分）**: tsc 0 / lint 0 / `npm test` 245 files 2,253 件 / `test:integration` 373 件（1 skip、pass 記録）/
  `test:e2e` 77 件（pass 記録）/ docs 整合性・約束カタログ・引き継ぎ形式・制御バイト・fail-open の各検査 ALL PASSED。
  CI は GitHub 停止中で未実施
- **候補 2 本の可否（別途報告済み）**: RLS の黙った 0 件は「ID 指定 1 件取得 2 route に限り、0 件時だけ
  service role で存在確認して既存語彙で記録」なら可。読み取り監査は DB 側不可（述語が STABLE）・アプリ側は量と
  レイテンシで破綻・ログ側は pgaudit / PostgREST 未設定かつ保持期間未確認で、引き金付きへ落とす

## 後任AIへの注意
- この実装で壊してはいけない前提: `/login` の Server Component は **cookie ではなくヘッダ** `x-aidd-denial` を読む。proxy が `/login` で cookie を消す限り、`cookies()` には削除が先回りする
- 似ているが別物の用語: `DENIAL_ROUTE_HEADER` / `DENIAL_METHOD_HEADER`（Route Handler 用。転送リクエストに毎回付く）と `DENIAL_COOKIE_NAME` / `DENIAL_PAYLOAD_HEADER`（proxy の転送用。admin 拒否のときだけ）
- 勝手にリファクタしない場所: `forwardedHeaders()` の「無ければ削除」。消すと偽ヘッダが素通りする
