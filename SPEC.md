# SPEC: gap checkの実行をStop hookで機械トリガー化する（issue #488）

- issue: #488
- feature名: `issue-488-gap-check-stop-hook`
- baseCommit: `22610bb516914f9d38ba06eeb456420840b78722`
- 作成日: 2026-07-22

## Part 1: 何ができるようになるか（★人間がレビューする部分）

現在、AIDDフロー実行後のgap check（`check-loop-observability-gap.sh` /
`check-agent-progress-gap.sh`）は、common.mdの4ステップ手動手順（実行前にwc -lで
before件数を控え、フロー完了後にexpectedと突き合わせて手動実行）に依存しており、
「checkし忘れたら気づけない」第3層ルール（人起動）のまま残っている。

本実装後は:

- オーケストレーターはフロー前後に**リポジトリ内の記録スクリプトを呼ぶだけ**になり、
  gap checkの実行自体は**Stop hookが機械トリガー**する（issue #411原則: 起動トリガーが
  機械になる）
- 記録漏れ（hasGap）があれば、フロー完了後の最初のターン終了時にsystemMessageで
  警告が出る（block不可・warningのみ）
- 「書いたのにcheckし忘れる」故障モードが構造的に消える。「stateファイルへの記録自体を
  書き忘れる」は自己申告依存のまま残る（issue本文の既知の限界どおり）

### 動作イメージ

1. フロー開始時: `scripts/record-gap-check-state.sh before` を実行
   → スクリプト自身が現在のログ件数を数えて `.aidd/gap-check-state.json` に記録
   （手動wc -l・手動jqカウントが不要になり、控え間違いも消える）
2. 各フェーズ完了後: `scripts/record-gap-check-state.sh expected --agent-progress 4` /
   `... expected --loop-observability 10 --agent-progress 12` を実行
   → expected件数をstateファイルに**加算**記録（phase1とphase2の期待値を合算できる）
3. セッションのターン終了時: Stop hook（`scripts/check-gap-check-state.sh`）が
   stateファイルを見て、expectedが記録済みなら両gap checkを自動実行
   → hasGapならsystemMessageで警告、実行後にstateファイルを削除

## Part 2: 変更内容

### 2-1. 新規 `scripts/record-gap-check-state.sh`

- `before`サブコマンド: `logs/loop-observability.jsonl`の行数と
  `logs/agent-progress.jsonl`のdone/failed件数を**スクリプト自身が計測**し、
  `.aidd/gap-check-state.json` に `{beforeLoopObservability, beforeAgentProgress,
  recordedAt}` を書き出す。既にbeforeが記録済みの場合は上書きしない（first-write-wins。
  1フロー実行の起点を固定するため）
- `expected`サブコマンド: `--loop-observability N` / `--agent-progress M`（いずれも任意、
  最低1つ必須）を受け取り、stateファイルの `expectedLoopObservability` /
  `expectedAgentProgress` に**加算**する（phase1のexpectedAgentProgressRecords=4と
  phase2の=12を合算するため）。beforeが未記録ならエラー（exit 1）で手順逸脱を検知
- done/failed件数の計測ロジックは既存の手動手順（common.mdのjqコマンド）と同一判定
- `.aidd/` はgitignore済み（run-manifestと同じ扱い）
- **呼び出し元はオーケストレーター（Claude本体）のみ**（スクリプトヘッダに明記。
  Workflow DSLはfilesystem API不可のため構造的に呼べず、サブエージェントへの記録指示にも
  含めない）。オーケストレーターのBash実行は逐次のためread-modify-write競合は発生しない
  前提だが、保険として書き込みは一時ファイル→`mv`のatomic方式にする（ロックは導入しない）

### 2-2. 新規 `scripts/check-gap-check-state.sh`（Stop hook本体）

- `.aidd/gap-check-state.json` が無ければ何もせず exit 0（AIDDフロー非実行セッションでは
  完全に沈黙。opt-in設定にも依存しない）
- stateファイルはあるがexpectedが1つも無い場合:
  - `recordedAt`から24時間以内 → フロー実行中とみなし何もしない（クリアもしない）
  - 24時間超 → 中断されたフローの残骸とみなしstateファイルを削除し、**systemMessageで
    「gap check未実施のままstateを破棄した」旨を一言警告する**（block不可。「中断しただけ」と
    「漏れを見逃して消えた」を区別可能にし、破棄自体を観測可能にするため。停止①レビューでの
    指摘を反映）
- expectedがある場合:
  - `expectedLoopObservability`があれば `check-loop-observability-gap.sh --before <state値>
    --expected <state値>` を実行
  - `expectedAgentProgress`があれば `check-agent-progress-gap.sh` を同様に実行
  - いずれかが `hasGap: true` → 既存Stop hook群（`gate-effectiveness-monthly-check.sh`等）と
    同形式のJSON（`{systemMessage}`のみ）で警告を出力（**block不可・warningのみ**。
    `hookSpecificOutput`/`additionalContext`はSessionStart hook用のためStop hookでは使わない）
  - gap checkの実行自体が失敗した場合（npx/jq等の環境要因、出力に`hasGap`が無いままexit≠0）は、
    本物のgap警告とは**別の文言**（「実行自体に失敗・記録漏れの有無は未判定」）で警告する
    （レビュー指摘の反映: 原因調査の初手を誤らせないため）
  - 実行後（gap有無にかかわらず）stateファイルを削除する
- 環境変数でstateファイルパス・gap checkスクリプトパスを差し替え可能にする
  （フェイク注入テストのため。既存hookテストと同型）
- 堅牢性（レビュー指摘の反映）: jq不在の環境では何もせず沈黙する（stateは残し次回に委ねる）。
  `recordedAt`が非数値の破損stateはクラッシュさせず「破棄＋警告」に倒す（クラッシュすると
  stateが残り毎ターン再クラッシュするため）

### 2-3. `.claude/settings.json`

- Stop hooksに `scripts/check-gap-check-state.sh`（timeout 90）を追加登録
  （当初案は30秒だったが、gap checkスクリプトが内部で呼ぶ`npx -y tsx`のコールドスタートで
  超過しうるというレビュー指摘を受け、`verify-claims.sh`と同じ90秒に引き上げた）

### 2-4. テスト

- `scripts/record-gap-check-state.sh` / `scripts/check-gap-check-state.sh` それぞれに
  `.test.sh` を新設（`bash scripts/<name>.test.sh` で実行。statusline.test.sh等と同じく
  `npm test` 対象外のbashテスト）。ケース:
  - before記録 → 値がログ実件数と一致 / 二重実行でfirst-write-wins
  - expected加算 → 複数回呼び出しで合算される / before未記録ならexit 1
  - Stop hook: stateファイル無し→沈黙 / expected無し・24h以内→何もしない /
    expected無し・24h超→削除＋破棄警告のsystemMessage出力 / gap無し→警告なしでクリア /
    gap有り→systemMessage出力（フェイクstateファイル＋フェイクログ注入）

### 2-5. ドキュメント更新

- `docs/agents/common.md`:
  - 「loop-observabilityログの記録漏れ検知」「サブエージェント進捗の可視化」両節の
    4ステップ手動手順を「`record-gap-check-state.sh`で記録すればStop hookが自動実行する。
    手動実行は再検証時のみ」に更新
  - 「ツール制約回避のload-bearing workaround棚卸し」表の該当行（gap check実行が人起動の
    まま第3層に残っている旨の記述）を更新
  - 既知の限界（stateファイルへの記録自体は自己申告のまま）を明記
- ルート `CLAUDE.md`: AIDDフロー手順のgap check記述を新手順（before記録→expected記録）に
  差し替え

## 並列グループ宣言

- **グループ1（単独・並列化なし）**: 2-1〜2-5すべて。record→check→settings→テスト→
  ドキュメントは相互依存のため、implementer 1体で直列実装する。
  （注: #493で確認した編成ギャップ（scripts/配下は5ロール外でintegratorが代行）が
  再発する可能性が高い。integratorによる代行実装を今回は許容する）

## 受け入れ条件

- フロー実行後、オーケストレーターがターンを終えるだけで両gap checkが自動実行され、
  記録漏れがあればsystemMessage警告が出る（テストで検証）
- AIDDフローを実行していないセッションではStop hookが完全に沈黙する（テストで検証）
- 起動トリガーが機械（Stop hook）である（issue #411原則）
- 全`.test.sh`がpass / `npm test` green（既存テストの回帰なし）/ `npm run lint` green

## 対応しないこと（明示的スコープ外）

- `~/write_aidd_stats.sh`（ホーム側）への機能追加: リポジトリ外ファイルは本PRの管理外。
  記録はリポジトリ内スクリプトに一本化する（issueの設計案1の後者を採用）
- stateファイル書き込み自体の機械強制: Workflow DSLのfilesystem API制約により不可能
  （issue記載の既知の限界。「書き忘れ」の検知はissue #495の類似機構で将来検討）
- `aidd-1-1-deep-task.js`のgap check未対応問題（common.md記載の既存の限界）の解消
- DB・データ取得層・UI・RLS・migrationには一切触れない
- Phase 1 Sweep(data軸)の既存コードへの一般指摘（エラー形式混在・as キャスト等）:
  本issueと無関係のためスコープ外
