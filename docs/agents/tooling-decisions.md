# ツール・機能導入可否の判断記録

このファイルは [`common.md`](./common.md) の「毎セッション必須ルール」から分離した参照ドキュメントである（issue #486）。個々の公式機能・プラグインを採用するか見送るかの実機検証結果・判断理由を記録する。行動を変える指示ではなく、経緯を確認したいときに読む。[`decisions.md`](./decisions.md) が設計判断一般の索引であるのに対し、ここは「外部ツール・機能を使うか使わないか」という導入可否判断の全文を持つ（issue #491でdecisions.mdの該当エントリをここへ統合した）。common.md側には各節への1行リンクが残っている。各エントリ冒頭の太字1行が結論。

## Bashサンドボックス機能は現行toolchainと非互換のため保留（issue #438）

**結論: `sandbox.enabled: true`はgh/supabase CLIのTLS証明書検証を壊すため導入不可。upstream対応まで保留。**

issue #438は、公式docs調査で見つかったBashサンドボックス機能（OSレベル分離、macOSはSeatbelt
実装）を導入し、無人自律実行の安全基盤（データ流出経路の構造的な遮断）を強化する提案だった。
実装前のゲート条件確認（公式ドキュメントでの仕様実機確認）の過程で、下書き前提との相違が
複数見つかり、最終的に実機検証で「現行toolchainとは非互換」という結論に至った。

**背景の経緯（下書き前提との相違、判明順）:**
1. `sandbox.credentials`（deny/mask）は、セキュリティ設計上プロジェクト側設定
   （`.claude/settings.local.json`含む）では無視され、ユーザー個人の`~/.claude/settings.json`
   でしか効かない。リポジトリにコミット/共有できるのは`filesystem`/`network`設定のみ
2. 下書きが想定していた「まずfallback許容モードで観測開始」という専用モードは公式には
   存在しない。代わりに`allowUnsandboxedCommands`（既定true）がある

**`filesystem.allowWrite`のスコープ設計（実装時点の判断）:** サンドボックスの目的が書き込み
制限である以上、`$HOME/**`のような広い許可は制約を骨抜きにする。本プロジェクトのCLAUDE.md
運用が実際にcwd外（`$HOME`配下）への書き込みを要求する箇所を`write_aidd_stats.sh`/
`aidd_session_report.sh`の実装を読んで洗い出し、`~/.claude/aidd-session-stats/`（書き込み
先ディレクトリ）と`~/.claude/pending_issues.jsonl`（issue自動作成用の単一ファイル）の2パスに
個別列挙で絞った。この設計自体は妥当だったが、後述の通りそもそもsandbox自体が導入不能と
判明したため未使用のまま終わっている。

**実機検証で確定した非互換性:** 隔離ディレクトリ（本体リポジトリとは別）でheadlessセッション
（`claude -p`）を用い、`sandbox.enabled: true`の複数パターンでgh/supabase CLIの動作を検証した。

| 設定パターン | 認証方式 | 結果 |
|---|---|---|
| network.allowedDomains設定あり | keychain(通常) | `gh`がTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| filesystem.allowWriteのみ（network設定なし） | keychain(通常) | `gh auth status`がkeychainアクセスエラーで失敗（2回再現） |
| filesystem.allowWriteのみ（network設定なし、確認済み） | GH_TOKEN環境変数（keychain回避） | `gh issue list`がTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| 同上 | SUPABASE_ACCESS_TOKEN環境変数（keychain回避） | `supabase projects list`が同一のTLS証明書検証エラーで失敗（`x509: OSStatus -26276`） |
| サンドボックス無効（対照実験） | 通常 | `gh issue list`成功（終了コード0） |

`network.allowedDomains`の設定有無に関わらず、`sandbox.enabled: true`にした時点でBashの通信が
TLS中継の対象になる。keychain認証を環境変数トークンで迂回してもTLS層で同じエラーが再発する
ことから、keychainアクセスの問題とTLS中継の問題は別々に存在し、片方を回避してももう片方で
壊れる、という二重の壁だった。gh・supabase CLIの両方で同一エラーが再現しており、Go製CLI全般に
共通する非互換性である可能性が高い（curlは同様の状況で成功しており、影響を受けるのはGoの
`crypto/tls`がサンドボックスのTLS中継プロキシ証明書を信頼しないケースに限られると考えられる）。

このリポジトリの開発フローはgh（issue/PR管理）・supabase CLI（migration/DB操作）の両方に
強く依存しており、`sandbox.enabled: true`を有効化すると開発が成立しない。upstream側でTLS
中継プロキシの証明書をGoバイナリが信頼できるようにする対応（またはサンドボックス側に除外
設定）が提供されるまで、issue #438は保留とする。

**再開条件:** Claude Code側のリリースノートでsandbox×Go製CLIの既知問題に対応が入った場合、
またはTLS中継を回避しつつ書き込み制限のみ有効化する設定が新たに追加された場合。

## Channels（issue #448）は今回のユースケース（夜間ジョブ通知）に不向きなため見送り

**結論: 「イベントはセッションが開いている間のみ届く」という制約が夜間バッチ通知という想定用途と噛み合わず、実装せず見送り(close)。**

issue #448は「夜間検査ジョブ（issue #443）の結果通知を、既存の音+macOS通知からClaude Code公式
Channels（research preview、Telegram/Discord/iMessage連携）に移行する」という提案だった。
issue本文自体に「Channelsの現行仕様・データ送信範囲を確認し、医療プロジェクトとして許容
できるかを判断してから着手」というゲート条件が明記されていたため、実装前に公式ドキュメントで
実機確認した（issue #438と同じ手順）。

**確認できた事実:**
1. Channelsは実在する（research preview段階、GA版ではない）。Telegram/Discord/iMessage・
   カスタムWebhookに対応
2. 通知メッセージ本体（`content`+`meta`）のみが外部サービスに送信され、セッション履歴・
   ファイル内容・会話全体はデフォルトでは送信されない
3. **ただしPermission Relay機能を使う場合、ツール実行の承認画面（コマンド内容・Writeの
   対象パス等）が外部チャネルに出力される可能性がある**
4. データ暗号化・ログ保持期間・HIPAA等の規制対応について、公式ドキュメントに一切明記が
   無かった（重大な空白）

**issue #448の前提を崩す決定的な発見:** 公式ドキュメントに「イベントはセッションが開いて
いる間のみ届く」という記述があった。issue #448が想定していた用途（Claude Codeセッションが
閉じている夜間の時間帯に、外部のcron/スケジューラから起動されたジョブの結果を通知する）は、
Channelsの設計そのものと噛み合わない。バッチ通知のためにClaude Codeセッションを常時起動
しておく必要が生じ、運用負荷が増すだけで本末転倒になる。

**結論の詳細（実装せず見送り、close）:** issue #438（sandbox）と同型のパターンで、実機確認の結果
issueの前提（バッチジョブ通知への活用）が崩れた。加えて医療プロジェクトとして重要な
データガバナンス面（暗号化・保持期間・規制対応）の公式ガイダンスが不足しているという
独立した懸念も残ることを記録しておく。`blocked`（issue #438のように上流の対応待ち）ではなく
`close`とした理由は、issue #438の非互換が「現行toolchainとの技術的な非互換」という明確に
解消され得る条件だったのに対し、issue #448は「そもそも設計思想がこのユースケース向けでは
ない」という、Channels機能自体の仕様変更が無い限り解消されない性質の違いによる。

**再開条件:** Channelsがバッチ/スケジュール実行のイベント通知（セッション非開時の通知）を
公式サポートするようになった場合、またはHIPAA等の規制対応が公式に明記された場合。

## claude-code-action（issue #447）は費用対効果の観点で見送り

**結論: 技術的には導入可能だが、ローカルセッションで既に十分こなせており追加のAPI従量課金に見合う必要性が無いため見送り(close)。**

issue #447は「GitHub Actions内でclaude-code-actionを導入し、@claudeメンションでissue
トリアージ・PR対応を自動化する」という提案だった。issue本文自体に「費用比較を先に行う。
合わなければ『検討の結果見送り』でcloseしてよい（eval CI化をコストで見送ったのと同じ
判断軸）」と明記されており、ゲート条件（課金体系・権限スコープ・Freeプランでの利用可否）を
公式ドキュメントで確認した上で、費用対効果の観点から判断した。

**確認できた事実:**
- `claude-code-action`は実在・GA版（Anthropic公式、`github.com/anthropics/claude-code-action`）
- **課金は既存のClaude Pro/Maxサブスクとは別建て**。Anthropic API keyでの従量課金が必須
  （ローカルのClaude Codeセッション利用とは完全に別ライン）。加えてGitHub Actions実行時間の
  消費もある（Freeプランは月2000分、これ自体が利用不可の理由にはならない）
- 導入にはリポジトリの`Contents`/`Issues`/`PR`へのRead & Write権限を持つGitHub App
  インストールが必要

**判断（技術的可否ではなく費用対効果）:** issue #438・#448とは異なり、技術的に導入不能
だったり前提が崩れたわけではない。むしろ実装自体は可能。しかし、このリポジトリの運用は
issueトリアージ・PR作成をローカルのClaude Codeセッション（既存サブスクの範囲内）で既に
こなせており（本issue自体の判断を含め、1セッションで9件以上のissueを処理した実績が
このリポジトリの直近の履歴にある）、claude-code-actionを導入すると同種の作業に対して
API従量課金という追加コストが重複して発生するだけになる。ローカル運用が既に十分機能して
いる現状では、追加コストに見合う明確な必要性が無いと判断した。

`blocked`ではなく`close`とした理由: 技術的な非互換（issue #438）や設計思想の不一致
（issue #448）ではなく、単純な費用対効果の判断のため、上流側の変化を待つ性質のものでは
ない。

**再開条件:** ローカルセッションでは手が回らない規模までissue/PR量が増えた場合、または
API課金がClaude Pro/Maxサブスクに統合される等、追加コスト構造が変わった場合。

## security-guidanceプラグインでknown-failure-patterns.mdを機械検知化（issue #440）

**結論: 公式security-guidanceプラグインをチーム共有（3層とも）で有効化し、known-failure-patterns.mdのチェックリストの一部を機械検知化した。**

issue #440は「公式のsecurity-guidance機能を導入し、`known-failure-patterns.md`の自然言語
チェックリストを機械検知化する」という提案で、ゲート条件（機能の正確な名称・導入手順・
`security-patterns.yaml`のスキーマを公式docで実機確認してから着手）に従い実機確認した。

**確認できた事実（下書きとほぼ一致、issue #438・#448とは異なり前提が崩れなかった）:**
- 正式名称は「Security guidance plugin」（`security-guidance@claude-plugins-official`）。
  公式プラグインとして実在する
- 3層構成: ①per-edit正規表現/部分文字列検知（LLM呼び出しなし・無料）②ターン末diffレビュー
  （モデル呼び出しあり）③commit/push時レビュー（より深いエージェントレビュー、20/時間の上限）
- 設定ファイルは`.claude/claude-security-guidance.md`（自然言語ガイダンス、特定の見出し構造
  不要）+ `.claude/security-patterns.json`（パターン定義。プラグインはYAML形式 `security-patterns.yaml` も受け付ける）。YAML形式は
  PyYAMLへの依存が生じるため、外部依存を増やさないよう本プロジェクトでは**JSON形式**を採用した
- `security-patterns.json`のスキーマ: パターンごとに`rule_name`・`regex`または
  `substrings`・`paths`（任意、globパターン）・`exclude_paths`（任意）・`reminder`
  （警告メッセージ、1KB制限）
- 有効化は`.claude/settings.json`の`enabledPlugins`（オブジェクト形式、
  `{"security-guidance@claude-plugins-official": true}`）
- 各層は環境変数で個別に無効化できる（`ENABLE_PATTERN_RULES`・`ENABLE_STOP_REVIEW`・
  `ENABLE_COMMIT_REVIEW`・`ENABLE_CODE_SECURITY_REVIEW`）

**判断: チーム共有（`.claude/settings.json`）で3層とも有効化。** OTel（issue #417）や
autoMode（issue #439）は「プラットフォーム側の制約でプロジェクト設定に書いても効かない」
という技術的制約があったため個人オプトインにしたが、security-guidanceにはそのような制約は
無い（`enabledPlugins`はプロジェクト側`settings.json`で有効に機能する）。per-edit層が無料で
価値が明確な一方、ターン末・commit時レビューにはモデル呼び出しに伴うトークンコストが生じる
ため、「チーム全員に一律適用すべきセキュリティ機能か、個人が選ぶコスト要因か」を人間に確認し、
医療プロジェクトとしてセキュリティ検知は全員に一律適用すべきという判断で、3層とも共有設定で
有効化することにした（層ごとの無効化オプションが環境変数として存在することも記録しておき、
将来コストが問題になった場合に`ENABLE_STOP_REVIEW=0`等で個別に絞れるようにしている）。

**実装したパターン（4件、issue原案どおり）:** `rls_bypass`・`bare_sql_in_data_layer`・
`possible_real_facility_name`・`security_definer_grant`。正規表現はJS系エンジンでも
確実に動くよう、インラインフラグ（`(?i)`）に頼らず文字クラス（`[Dd][Ii][Ss]...`）で
大文字小文字を吸収する書き方に統一した（プラグインの正規表現エンジンの実装言語が
公式docに明記されておらず、Python固有の`(?i)`構文がサポートされない可能性を考慮した）。
各パターンはpython3の`re`モジュールでテストケース11件を用いて動作確認済み（実際の
プラグインの正規表現エンジンでの動作は別途確認が必要、後述の既知の限界参照）。

- `.claude/security-patterns.json`: `rls_bypass`（RLS無効化・ポリシー変更検知）・
  `bare_sql_in_data_layer`（`src/lib/supabase/**`での生SQL実行検知）・
  `possible_real_facility_name`（seed/E2E/eval-fixturesパスへの実在施設名らしき文字列の検知）・
  `security_definer_grant`（`SECURITY DEFINER`関数の検知）の4パターンを定義
- `.claude/claude-security-guidance.md`: RLS/facility境界の原則（全ポリシーが`auth.uid()`
  または`facility_id`参照、admin判定はDB role経由、機微データをINFO以上でログ出力しない等）
  を自然言語で記述
- ターン末diffレビュー・commit時レビューはモデル呼び出しを伴いトークンコストが発生する
  （`ENABLE_STOP_REVIEW=0`・`ENABLE_COMMIT_REVIEW=0`環境変数で個別に無効化可能）。今回は
  per-edit層と合わせて3層とも有効化する判断をした（人間の確認済み）

**既知の限界:** プラグインの実際のインストール（`/plugin install
security-guidance@claude-plugins-official`）は対話的な操作が必要で、このセッションでは
実行できていない。`enabledPlugins`の設定のみ先行してコミットしており、実際に機能するかは
次回以降のセッションで人間が`/plugin install`を実行してから確認する必要がある。

## blockedラベルの再開条件見直しはSessionStart hookで機械ポーリング（issue #453）

**結論: `blocked`ラベルの付いたOPEN issueが既定90日以上更新されなければSessionStart hookが警告する、最小限のポーリングで解決した。**

issue #438を`blocked`にした際、`decisions.md`に再開条件（Claude Code側の対応・回避策の登場）を
明記したが、**この再開条件を誰がいつ見直すか**の仕組みが無かった。issue本文は3つの選択肢
（1. cron等の定期実行でリリースノートを確認、2. 「気づいたら見る」の明文化のみ、3. blocked
issueに再確認の目安時期をコメントしトリガーにする）を提示していた。

**却下した選択肢:**
- **案1（cron等の常時稼働）**: リリースノートの内容を機械的に解釈して「issue #438の再開条件を
  満たしたかどうか」を自動判定するのは自然言語理解が必要で現実的でない。仮に「更新があった
  こと」だけを検知しても、それが本当に該当issueの再開条件を満たすかは結局人間が読んで判断する
  必要があり、常時監視の複雑さに見合わない。
- **案2（気づいたら見る、のみ）**: 「検知手段のないルールの棚卸し」（issue #339）の第3層ルールを
  ただ1行増やすだけで、issue #453自体が解決しようとしている問題（書いただけでは気づかれない）
  を再生産する。

**採用した設計（案3の機械化）:** 「再確認の目安時期」を個別にコメントする代わりに、`blocked`
ラベル自体を目安にした。`blocked`ラベルの付いたOPEN issueの`updatedAt`（最終更新日時）が
既定90日を超えたら、`scripts/check-blocked-issues-staleness.sh`（SessionStart hook）が
警告する。90日という閾値はissue本文が例示した「3ヶ月後」をそのまま採用した。90日はあくまで
「見直すきっかけを作る」ための機械的な目安であり、リリースノートの実際の更新頻度とは無関係
（`BLOCKED_ISSUE_STALE_DAYS`環境変数で個別に調整可能にしている）。

`check-branch-pr-status.sh`と同じ「セッションが始まった時に気づける」最小限のバー
（cronのような常時稼働は導入しない、issue #411原則）に留めた。日付計算はmacOS(BSD date)と
Linux(GNU date)の非互換を避けるため、他のスクリプト（`check-run-manifest-presence.sh`等）と
同様にpython3に委ねている。テストは`check-branch-pr-status.test.sh`と同じ「フェイクghを
PATHの先頭に注入する」パターンを踏襲し、実際のGitHub APIに依存せず決定的に検証できるように
した（テスト内の相対日時もpython3でテスト実行時刻基準に動的生成し、時間経過で壊れないように
している）。

## 定期実行の機械トリガー化はSessionStart hookに一本化、OS launchdは見送り（issue #443）

**結論: 常時稼働のOS launchdは無人での外部作用リスクが質的に異なるため見送り、既存のSessionStart hookパターンに一本化した。**

issue #443は「検知手段のないルールの棚卸し」（issue #339）の第3層ルールのうち、検査
スクリプト自体はあるのに起動が人依存のもの（loop-observability/agent-progress gap check・
baseline鮮度チェック・fault injection四半期訓練・eval:workflows未実行検知）を、OS launchd等の
夜間バッチジョブでまとめて機械トリガー化する提案だった。

**実装前に対象スクリプトを実際に読んで判明した制約:**
- `scripts/check-loop-observability-gap.sh`・`scripts/check-agent-progress-gap.sh`は
  `--before N --expected M`という、**単発のAIDDフロー実行の直前直後の件数差分**を引数に
  要求する設計だった。これは「フロー実行直後にオーケストレーターが呼ぶ」ことを前提にした
  チェックであり、独立した夜間バッチジョブには「直前のフロー」という文脈が無いため、
  そのままでは呼び出せない
- `scripts/check-agent-baseline-freshness.sh`（issue #429）も同様に、`<base-ref> <head-ref>`
  というPR diffを前提にした設計で、CI（PRの差分チェック）用途としては正しく機能している。
  夜間バッチに無理に転用する動機が薄い
- eval:workflows（`scripts/eval-workflow-prompts.sh`）は`logs/`に何も書き込んでおらず、
  「最終実行日時」を記録する仕組み自体がそもそも存在しなかった。未実行検知を作るには、
  まず実行記録の仕組みを別途追加する必要がある（本issueの前提が成立していなかった）

**唯一そのまま実装可能だったもの:** `docs/agents/fault-injection-drill.md`の
「## 次回実施予定日」欄は、既に「次回実施予定日」という単一の日付フィールドを持ち、
「リマインド機構は無い」と明記されていた（issue #443がまさに埋めようとしていたギャップ
そのもの）。これだけは追加の前提無しに、日付比較だけで機械化できた。

**OS launchdを見送り、SessionStart hookに一本化した判断:** issue原案は「launchdはClaude
不要で軽い」という利点を挙げていたが、launchdの`.plist`インストール（`~/Library/LaunchAgents/`
配下への恒久的な登録、`launchctl load`によるOS常駐サービス化）は、リポジトリの外側で
ユーザーの実行環境そのものに手を入れる操作であり、しかも無人でGitHub issue作成等の外部作用を
持ちうる。これは今回セッション内で完結する他の変更（フックスクリプト追加等）とは質的に
異なるリスクを持つと判断した。一方、SessionStart hookは既にこのリポジトリで「機械トリガー」
として扱われており（issue #411の原則を満たす。`check-blocked-issues-staleness.sh`（issue
#453）と同型）、恒久的なOS常駐サービスを新設せずとも「セッションが始まった時に気づける」
という目的は達成できる。この判断により、issue原案の「棚卸し表から最大4行削減」という見込みは
実質1行（fault injection訓練の放置検知）に縮小したが、残りの3項目（gap check 2件・
eval:workflows未実行検知）は本issueとは別に、それぞれの前提（実行記録の仕組み等）を
別途整備してから再検討することとした。3項目とも実装済み: gap check 2件はissue #488、
eval:workflows未実行検知は`scripts/check-eval-runs-freshness.sh`＋CI（issue #496、
`.github/workflows/eval-runs-freshness-check.yml`）で対応した。

## autoMode(hard_deny)は個人設定のみ有効・設定し忘れ検知はSessionStart hookで（issue #439）

**結論: autoMode.hard_denyはプラットフォーム仕様上プロジェクト側設定では読まれないため個人オプトイン方式にし、設定し忘れをSessionStart hookで検知する。**

issue #439は当初「autoMode設定(hard_deny)で医療データ外部送信・RLS無効化を無条件ブロックする」
という機能導入提案だったが、ゲート条件確認（公式ドキュメント実機確認）の結果、issue #438の
`sandbox.credentials`と同型の制約が判明し、方針を変更した。

**確認した事実（推測ではなく公式ドキュメントの原文で確認済み）:** `autoMode`のclassifierは
`.claude/settings.json`・`.claude/settings.local.json`（どちらもリポジトリのディレクトリ内に
存在するファイル）から`autoMode`設定を読まない。
出典: https://code.claude.com/docs/en/auto-mode-config.md 「Where the classifier reads
configuration」セクション。理由も明記されている: "a checked-in repo or a build step could
otherwise inject its own allow rules"（コミットされたリポジトリやビルドステップが、独自の
許可ルールを勝手に注入できてしまうため）。`.claude/settings.local.json`を対象外にしている
理由も同様（"Excluding .claude/settings.local.json also closes the case where a repository
commits the file or a local tool or build step writes it."）。

この事実確認自体、当初は調査エージェントの要約を鵜呑みにしそうになったが、「その理由は
本当にドキュメントに書かれているのか、それとも推測か」という指摘を受けて出典URLと原文引用を
再確認する一手間を挟んだ。issue #438の「実装前に実機確認する」を、「実機確認の結果自体も
一次情報で裏取りする」までもう一段踏み込んだ形。

**判明した仕様（下書き想定と一致した部分）:** キー名（`environment`/`hard_deny`/`soft_deny`/
`allow`）・評価順序（`hard_deny → soft_deny → allow → 明示的なユーザー意図`、`permissions.deny`
より後に評価される追加の層）は下書きどおりだった。

**判明した既知の限界（下書きに無かった情報）:** 各classifier呼び出しはトークンコストが
増加する。また3回連続/20回総ブロックで自動fallbackする仕様があり、「ユーザー意図でも
上書き不可の無条件ブロック」という説明どおりには機能しきらない可能性がある（一定数
ブロックが続くと効かなくなる）。

**結論の詳細:** `autoMode`はプロジェクト側にコミットして全員へ強制する形では実装
できない。issue #438のcredentials設定と同じ構造的制約であり、上記「Bashサンドボックス機能は
現行toolchainと非互換のため保留」と同種の判断が必要になった。ただし#438（toolchain非互換で
使用そのものが不可能）とは異なり、#439は「使うこと自体は個人設定で可能・プロジェクト側からは
強制できないだけ」という違いがあるため、保留にはせず「推奨設定をdocs/agents/common.mdに
文書化し、各自の`~/.claude/settings.json`への追加を促す」個人オプトイン方式で実装した。

**「書いただけでは気づかれない」への追加対応:** ドキュメント化のみで終えると、issue #423
（loop-observability記録漏れ、自然言語指示への依存が実際に5日分の記録欠落を招いた事例）と
同型の弱さが残るという指摘を受け、`scripts/check-automode-config.sh`（SessionStart hook）を
追加した。個人設定に`autoMode.hard_deny`が存在しなければセッション開始時に警告する
（block不可・warningのみ、`check-otel-collector-status.sh`と同じパターン）。ただし
`hard_deny`の**内容**（実際に医療データ外部送信・RLS無効化を正しくカバーしているか）までは
検証しない。存在チェックに留めた理由は、`environment`/`hard_deny`が自然言語記述であり、
内容の妥当性を機械的に判定する信頼できる方法が無いため（issue #438のcredentials同様、
platform側の内部メカニズムが完全には文書化されていない）。

**有効化したい場合、各自の`~/.claude/settings.json`に以下を追加する（推奨設定・任意）:**

```json
{
  "autoMode": {
    "environment": "Supabase(prod)には患者・施設の実データが保存されている。supabase/migrations/配下がRLSポリシーの正本。",
    "hard_deny": [
      "患者・施設の実データをSupabase以外のドメイン（外部API・PR本文・issue本文等）へ送信しない",
      "RLS policyの無効化・変更をブロックする",
      "本番Supabaseへの直接DDL実行をブロックする"
    ]
  }
}
```

## subagent frontmatterの`skills:`プリロード・`permissionMode: plan`は見送り、`maxTurns`は延期（issue #652）

**結論: `skills:`プリロードはClaude/Codex共存設計と衝突するため見送り。`permissionMode: plan`は
実機検証で書き込みをブロックしないことを確認したため見送り。`maxTurns`はsweep系の決定的手順を
打ち切るリスクがあるため実測データが揃うまで延期する。**

issue #652は2026-08-25の公式ドキュメント突き合わせレビュー（`docs/ai-config-map.md`とは別件、
Anthropic公式`code.claude.com/docs/en/sub-agents.md`で実在確認済み）で見つかった、subagent
frontmatterの未活用フィールド3種（`skills:`・`permissionMode:`・`maxTurns:`）の導入検討issue
だった。Phase 1調査で以下が判明し、いずれも見送り／延期とした。

### `skills:`プリロード（known-failure-patterns.mdの機械保証化）を見送った理由

issue原案は「`docs/agents/known-failure-patterns.md`を`.claude/skills/`配下のスキルに変換し、
reviewer・sweep系のfrontmatterに`skills:`プリロード指定する」というものだった。しかし
`known-failure-patterns.md`は`.agents/skills/handoff-format/SKILL.md`（Codex用の`handoff-format`
スキル）からも参照される**ツール中立の共有資産**であることが判明した。`.claude/skills/`への
移動はClaude専用ディレクトリへ資産を囲い込むことになりCodex/Claude共存設計
（[`claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md)）に反し、
`.claude/skills/`と`docs/agents/`の両方に置く複製案はこのリポジトリが一貫して避けてきた
二重管理・ドリフトの温床になる（[`load-bearing-workarounds.md`](./load-bearing-workarounds.md)の
正本+複製+sync test方式が必要な規模の変更であり、今回のスコープには見合わない）。

加えて、現状の参照方式は原案が想定したよりも細かく設計されていることも判明した：
`reviewer.md`は全文参照、`sweep-ui.md`/`sweep-data.md`は担当セクションのみを参照する指示
（haiku・`effort: low`の軽量設計を守るため）で、全員へ一律プリロードすると軽量sweepに
無関係なセクション（RLS等）まで常時読ませることになり、この設計思想と衝突する。

**唯一の実利益（sweep-dbが「RLS/テナント分離層」セクションへの参照を持たない、issue #24型の
再発防止の穴）のみ、sweep-ui/sweep-dataと同型の手動参照節を追加する形で対応した
（`.claude/agents/sweep-db.md`）。プリロード機構自体は導入していない。**

### `permissionMode: plan`を見送った理由（実機検証）

reviewer・judge-panel・adversarial-verify（いずれも`tools: Read, Bash`で読み取り専用のはずが、
Bashで書き込み系コマンドを打てる余地がある）にread-only強制を機械的にかける手段として検討した。

`sweep-ui.md`に一時的に`permissionMode: plan`を追加し、Agent tool経由（`subagent_type:
"sweep-ui"`）で以下3種の書き込み系Bashコマンドを実行させたところ、**すべて許可プロンプトなしで
実行完了し、ファイル実体の作成も確認した**（検証後、frontmatterの変更は`git checkout --`で
元に戻した）：

1. `scripts/log-agent-progress.sh`（このリポジトリのサブエージェントが実運用で必ず呼ぶ進捗記録
   スクリプト。ファイル追記）
2. `echo ... > file`（直接ファイル書き込み）
3. `mkdir`（ファイルシステム変更）

read-onlyを機械強制する目的には使えないと判明した。むしろ「permissionMode: planを設定した」
という事実だけが残り、実際には効いていないのに読み手に誤った安心感を与えるリスクがあるため、
導入しないことにした。

**再開条件:** Claude Code側の公式ドキュメントでplanモードのBashコマンド制御が明記・強化された
場合（現状のsub-agents.mdの記載は「プランモード」という値の存在のみで、Bash実行への制御内容は
明記されていない）、再度実機検証してから判断する。

### `maxTurns`を延期した理由

sweep-ui/sweep-data/sweep-db（すべてhaiku・`effort: low`）は「対象ファイルをrgで完全一覧化し、
除外後の一覧を最後まで確認してから結果を返す」という決定的な探索手順を必須としている
（各`.claude/agents/sweep-*.md`の「決定的な探索手順（省略禁止）」節）。対象ファイル数が
`maxTurns`の設定値を超えると、この手順は正常動作の途中でエージェントごと打ち切られる。
打ち切られたエージェントが返す空応答・部分応答は「指摘なし（正常完了）」と外形的に区別できず、
静かな見逃しモードを新設してしまう。

適正な`maxTurns`値を決めるための実測データ（エージェントタイプごとの典型的なターン数）が
現状存在しない。`docs/agents/observability-internals.md`の「agents設定変更時のbaselineスナップ
ショット機械強制（issue #429）」は`model:`/`effort:`変更のみを対象としており、ターン数の
baseline化は未整備。

**再開条件:** `scripts/snapshot-agent-baseline.sh`にエージェントタイプ別の典型ターン数が
記録されるようになった後、実測の最大値に十分な余裕を持たせた`maxTurns`値を設計する
（issue #654の低優先バックログに次点として記載済み）。

## なぜ読み取り専用ロールの Bash を settings.json の PreToolUse（agent_type 判定・deny）で機械強制し、subagent frontmatter の hooks や maxTurns / memory / skills / isolation は入れなかったか（issue #713）

**結論: `.claude/settings.json` の PreToolUse（matcher: Bash）に `scripts/check-readonly-bash.sh` を
登録し、hook 入力の `agent_type` が sweep-ui / sweep-data / sweep-db / sweep-types / reviewer /
completeness-critic / adversarial-verify / judge-panel のときだけ、許可リスト外のコマンドを deny する。
subagent frontmatter の `hooks:` は実機で効かなかったため使わない。他の frontmatter 機能は
issue #652 の判断（skills 見送り・permissionMode 見送り・maxTurns 延期）を維持し、memory と
isolation は理由を記して見送る。**

**背景:** 「読み取り専用」は `tools: Read, Bash` と自然言語指示に依存していた。issue #652 で
`permissionMode: plan` を実機検証したが書き込み系 Bash を止められなかった。グラフエンジニアリングで
言う「各ノードができる操作のホワイトリスト化」を、deny 型の PreToolUse hook で実現する。判定は
許可リスト方式（安全と証明されない限り拒否）で、進捗記録（`scripts/log-agent-progress.sh` 等）・
`npm test`・`git` の読み取り系は許可、リダイレクト・`sed -i`・`rm`・`git checkout`・`node -e` 等は
deny。難読化や許可スクリプト自体の副作用は対象外（「うっかり」を止めるゲート）。

**frontmatter hooks を使わなかった理由（2026-09-05 実測）:** 最初は 8 ロールの frontmatter に
`hooks.PreToolUse` を付けた。shell テストは green だったが、sweep-ui を Agent tool
（Claude Code 2.1.258、デスクトップアプリ）で起動して mkdir / リダイレクト / sed -i を実行させると
**すべて素通りし、実体ファイルも作成された**（transcript に本スクリプトの痕跡なし）。公式仕様には
「project subagent の frontmatter hooks は workspace trust 承認までスキップされ、debug log にだけ
エラーが出る」とあるが、このフォルダは `~/.claude.json` 上 trust 済みで、セッションの debug log も
存在せず、原因は未特定。原因が何であれ「設定したのに黙って効かない」経路は採用できない
（known-failure-patterns「green テストでも修正が効いていない」型そのもの）。公式に「settings
ファイルの hook はサブエージェント内でも発火し、入力に `agent_id` / `agent_type` が入る」と
明記されている経路へ切り替え、同じ手順で再実測して deny を確認した（mkdir / リダイレクト /
sed -i が deny、rg / git status / 進捗記録スクリプトが allow）。

**効く経路の限定:** `agent_type` は agentType 経由の呼び出しでのみ入る（frontmatter と同じ制約、
issue #433）。`aidd-phase1.js` の sweep-* と `aidd-phase2.js` の reviewer には効く。
`aidd-1-1-deep-task.js` の adversarial-verify / judge-panel / completeness-critic 2 回目は
インライン指定のため `agent_type` が入らず効かない（Agent tool 直接呼び出しのみ）。Workflow DSL の
agent() opts に hooks 相当は無い。

**maxTurns を入れなかった理由:** issue #652 の延期判断を維持。sweep 系の決定的探索手順が途中で
打ち切られると「指摘なし」と区別できない静かな見逃しになる。エージェントタイプ別の典型ターン数は
`logs/subagent-skeleton.jsonl` から transcript を辿れば集計できるが、transcript は
`cleanupPeriodDays` で消えるため、集計は baseline スナップショット（`scripts/snapshot-agent-baseline.sh`）
に組み込む必要があり別 issue とする。

**memory を入れなかった理由:** `memory: project` は `.claude/agent-memory/<name>/` に書き込み、
コミット対象のディレクトリで reviewer の書き換えが無関係な PR に混ざる。`local` は gitignore 前提で、
worktree を多用するこのリポジトリでは worktree ごとに分断されて学習が溜まらない。`user` は
`~/.claude/agent-memory/reviewer/` で worktree 横断だが他リポジトリの reviewer と混ざり、
ドメイン混同のリスクがある。共有ディレクトリを指定できるようになるまで見送る。

**skills / isolation を入れなかった理由:** skills は issue #652 で見送り済み。implementer への
handoff-format プリロードは、implementer の完了報告が Workflow の AgentResult schema であり
PR 本文ではないため効果が無い。isolation: worktree は `.env.local` 未コピー問題（common.md
ブランチ運用ルール）があり、`scripts/create-worktree.sh` 相当の初期化が必要。別 issue。

**How to apply:** 読み取り専用ロールを新設したら `check-readonly-bash.sh` の `READONLY_AGENT_TYPES`
既定値と test の scenario 2b に足す。許可コマンドを増やすときは許可リストと test の scenario 1 に
同時に足す。deny 理由に「書き込みが必要なら status: blocked で親に報告」と書いてあるので、
エージェントが回避策を探すのではなく blocked を返す設計になっている。subagent frontmatter の
`hooks:` を使いたくなったら、必ず Agent tool 経由の実機 RED（書き込みコマンドが本当に止まるか）を
先に取る。
