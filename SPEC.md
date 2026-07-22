# SPEC: AIDD stats書き出し呼び忘れの機械検知をStop hookに追加（issue #495）

- issue: #495
- feature名: `issue-495-aidd-stats-forgotten-detection`
- baseCommit: `95db91ceb638efe1c92260c28629d6cbbd248b94`（PR #511マージ後のorigin/main HEAD）
- 作成日: 2026-07-22

## Part 1: 何ができるようになるか（★人間がレビューする部分）

「AIDD stats書き出し（`~/write_aidd_stats.sh`）の呼び忘れ」は棚卸し表の第3層ルール
（検知手段なし）のまま残っている。issue #495の分析どおり、呼び忘れの主因は指示違反ではなく
**長時間セッションでのコンテキスト圧縮による指示喪失**であり、モデル世代によらず構造的に
再発しうる。本実装後は:

- Workflow実行を含むセッションで`start`記録が無いままターンを終えると、Stop hookが
  systemMessageで警告する（block不可・warningのみ）
- 警告は**同一セッションにつき1回だけ**出す（毎ターン繰り返される警告ノイズを避ける）
- AIDDフロー非実行セッション・判定材料が得られないセッションでは完全に沈黙する
  （fail-open。警告機能のエラーでセッションを妨げない）
- OTel等のopt-in設定には依存しない（既定環境で動く = 受け入れ条件どおり）

### 検知ロジック（issueの設計案2を具体化）

1. **Workflow実行の形跡**: `logs/subagent-skeleton.jsonl`（SubagentStart/Stop hookの機械強制
   記録、issue #423）のうち、`sessionId`が**現在のセッション**（Stop hook stdinの`session_id`）
   と一致し、かつ`agentTranscriptPath`が`subagents/workflows/wf_`配下のイベントが1件以上
   あるか。無ければ即沈黙
2. **start記録の有無**: statsファイル（`~/.claude/aidd-session-stats/<sha256(cwd)先頭16桁>.json`、
   `write_aidd_stats.sh`と同一のキー生成）に`session_start_at`（フォールバック:
   `phase1_start_at`）があり、かつその値が**現在セッションの開始時刻以降**であるか。
   古い値しか無い場合は「前セッションの残骸」であり、今セッションのstartは未実行と判定
3. **セッション開始時刻の取得**: Stop hook stdinの`transcript_path`の先頭行のtimestampを使う
   （hook入力に開始時刻そのものは無いため）。取得できない場合は判定不能として沈黙（fail-open）

### 実装先はリポジトリ内の新規Stop hook

issueの設計案1は「既存のaidd statsレポート生成hook」への追加を挙げているが、その実体は
`~/aidd_session_report.sh`（**ユーザーグローバル設定・リポジトリ外**）と確認した。
issue #488の`write_aidd_stats.sh`拡張を見送ったのと同じ理由（リポジトリ外ファイルは
PRで管理・レビューできない）で、**リポジトリ内の新規スクリプト + `.claude/settings.json`
登録**（#488と同型）とする。

## Part 2: 変更内容

### 2-1. 新規 `scripts/check-aidd-stats-recorded.sh`（Stop hook本体）

- stdin（hook入力JSON）から`session_id`・`transcript_path`を読む（`jq`。読めなければ沈黙）
- 上記検知ロジック1→3→2の順で判定（安い判定から。skeleton形跡なしが最頻経路）
- 警告済みマーカー: `.aidd/aidd-stats-warning-shown.json`に`{sessionId}`を記録し、
  同一セッションでは2回目以降沈黙（`.aidd/`はgitignore済み）。書き込みは#488と同じ
  一時ファイル→`mv`のatomic方式を踏襲する（停止①レビュー指摘の反映。なお最悪ケースでも
  「警告が2回出る」のみでデータ破損・ブロックには繋がらない）
- 警告文言には「コンテキスト圧縮で指示が失われた可能性」と「今からでも
  `~/write_aidd_stats.sh start`を呼べば以降のphaseは記録される」旨を含める
- 出力形式は既存Stop hook群と同じ`{systemMessage}`のみ。全経路exit 0（block不可）
- 環境変数注入ポイント（テスト用）: skeletonログパス・statsディレクトリ・マーカーファイル
  パス・stdin代替（session_id/transcript_pathの直接指定）
- jq・python3不在時は沈黙（#488レビュー指摘の横展開。python3はepoch変換と
  `sha256(cwd)`キー計算に使用しており、`write_aidd_stats.sh`自体もpython3依存のため
  実質的な追加依存ではない）
- 堅牢性（Phase 5レビュー指摘の反映）:
  - skeletonログの走査は末尾2000行に限定（追記専用・無ローテーションの肥大化対策。
    現在セッションのイベントは必ず末尾側にある）
  - jqは`-R` + `fromjson?`で1行ずつパースし、壊れた行が混在しても後続の正当な
    イベントを見失わない（共有ファイルへの排他制御なし並行追記が前提のため）
  - マーカー書き込み失敗（read-only等）でもクラッシュせず警告は出す（全経路exit 0の
    絶対要件。書けない間の警告重複は許容）
  - 完全一致キーで見つからない場合、statsディレクトリ全体を走査して今セッションの
    start記録を探す（cwdドリフト＝既知障害でキーがズレた場合の誤警告防止。
    他worktreeの並行セッションによる沈黙側の見逃しは意図的なトレードオフ）
  - transcriptのtimestampは末尾Z（UTC）形式のみ信頼し、それ以外は沈黙
  - `$HOME`未設定環境では沈黙（set -uクラッシュ防止）
  - 存在チェック（ビルトイン）をコマンド存在確認より先に置き、AIDD未使用セッションでは
    サブプロセス起動ゼロで終える

### 2-2. `.claude/settings.json`

- Stop hooksに `scripts/check-aidd-stats-recorded.sh`（timeout 15。純粋なファイル読みのみで
  npx等の重い依存なし）を追加登録

### 2-3. テスト `scripts/check-aidd-stats-recorded.test.sh`

フェイク注入方式（#488のテストと同型）。ケース:
- skeletonログ無し／このセッションのwf_イベント無し → 沈黙
- wf_イベントあり・statsファイル無し → 警告
- wf_イベントあり・statsのstart時刻がセッション開始より古い（前セッション残骸） → 警告
- wf_イベントあり・statsのstart時刻がセッション開始以降 → 沈黙
- 警告済みマーカーあり → 2回目は沈黙
- transcript先頭行が読めない → 沈黙（fail-open）
- 別セッションのwf_イベントのみ（sessionId不一致） → 沈黙

### 2-4. ドキュメント更新

- `docs/agents/common.md`:
  - 「検知手段のないルールの棚卸し」表の「AIDD stats書き出し」行を更新する。本検知が
    カバーするのは`start`の呼び忘れのみのため、行を丸ごと外すのではなく、**検知済みのstart
    部分への言及（検知手段リンク付き）を備考に記載した上で、未検知のまま残るphase単位の
    呼び出しに行の対象を狭めて残す**（表自身のルール「検知手段を実装したら表から外す」を、
    検知済みになった範囲にのみ適用する。全体を外すとphase単位の未検知が棚卸しから
    消えてしまうため）
  - 重要ファイル表に新スクリプトの行を追加
- ルート`CLAUDE.md`: 「AIDD stats 書き出しルール」に検知hookの存在を1行追記

## 並列グループ宣言

- **グループ1（単独・並列化なし）**: 2-1〜2-4すべて。implementer 1体相当で直列実装
  （#488と同様、5ロール編成ギャップ再発時はオーケストレーター実装を許容）

## 受け入れ条件

- Workflow実行を含むセッションでstats start記録が無いままターンを終えると警告が出る
  （テストで検証）
- 同一セッションで警告は1回のみ（テストで検証)
- AIDDフロー非実行セッション・判定不能時は完全沈黙（テストで検証）
- OTel等のopt-in設定に依存しない
- 全`.test.sh` pass / `npm test` green / `npm run lint` green

## 既知の限界（issue記載＋設計由来）

- `subagent-skeleton.jsonl`はセッション全体で共通のため、同一セッション内の
  「AIDDフローではないWorkflow実行」（例: 単発のresearch系Workflow）も形跡として拾い、
  誤検知しうる（issue記載どおりwarning-onlyのため許容）
- 検知できるのは「startの呼び忘れ」のみ。phase1/phase2等の途中フェーズの呼び忘れは
  検知しない（startさえあればレポートは生成されるため、最小バーとして妥当）
- セッション開始時刻はtranscript先頭行のtimestampに依存する（Claude Codeのtranscript形式
  変更で判定不能→沈黙に縮退する。fail-open設計のため安全側）

## 対応しないこと（明示的スコープ外）

- `~/aidd_session_report.sh`・`~/write_aidd_stats.sh`（ホーム側）の変更
- phase単位の呼び忘れ検知・stats内容の妥当性検証
- DB・データ取得層・UI・RLS・migrationには一切触れない
- Phase 1 Sweepの既存コードへの一般指摘（news routeのバリデーション・ItemRow型不一致等）:
  本issueと無関係のためスコープ外（必要なら別issue）
