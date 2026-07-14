# 検証サブエージェント(Stop hook自動裏取り) 設計

## 背景・目的

2026-07-11、issue #41/#42/#165のレビューで、CLIセッション(Claude Code CLI)が担っていた「主張の裏取り役」(行番号・既存コード挙動・環境変数名の一致等をgrepで確認する)を、VS Code側セッション内に自動組み込みする方針で合意した([[project_verification_subagent]])。

VS Code側で実装 → スクリーンショットをCLIセッションに貼って質問 → CLI側がgrepで裏取りして指摘 → VS Code側で修正、という往復を人間が手動で仲介する煩雑さを無くすことが目的。無くすべきは「人間が2セッション間を手動で仲介する部分」であり、検証プロセス自体ではない。

対象は `medical-inventory-vkumai` リポジトリ(VS Code側のセッション)。CLIセッションはアドバイスのみに徹する方針([[feedback_cli_advisory_only]])のため、この検証サブエージェントもVS Code側での自動実行が前提。

## アーキテクチャ

### 発火の仕組み

- Stop hookとして `scripts/verify-claims.sh` を追加する(既存の `scripts/doc-suggest-check.sh` と並走)
- hookのJSON入力から `session_id` を取得する(既存の `doc-suggest-check.sh` と同じ形式)
- `git diff HEAD` + `git status --porcelain` + untrackedファイル(`git ls-files --others --exclude-standard`)の中身を連結した内容のSHA256ハッシュを「現在のdiffハッシュ」として計算する(既存パターンを流用)
  - **注意(issue #352)**: `git diff HEAD` はtrackedファイルの差分のみを含み、`git status --porcelain`はuntrackedファイルを `?? path` の1行としか出さず中身を含まない。そのため新規(untracked)ファイルの中身だけを直して再Stopしてもハッシュが変わらず、「何も直していない」ケース(上記スキップ・再判定ロジックの2)と誤判定されブロックが継続してしまう。これを防ぐため、`git ls-files --others --exclude-standard -z` で列挙したuntrackedファイルの中身(ファイル名込み)も直接読んでハッシュ対象に含める。`git add -N`等でindexを書き換える方式は採らない(このスクリプトがリポジトリ状態を副作用的に変えないようにするため)
  - この方式により、既存の別Stop hook(`claude_stop_notify.sh`の`git add -A`)が先に走って untracked ファイルを tracked 化してくれることへの暗黙の依存が無くなる。`verify-claims.sh`単独でuntrackedファイルの中身を検知できるため、hookの実行順序に依存しない
- 状態は `.claude/.verify-state/<session_id>.json` に保存する:
  ```json
  { "last_diff_hash": "...", "last_verdict": "pass" | "blocked", "retry_count": 0, "last_findings_message": "..." }
  ```
  `last_findings_message` は、ケース2(ハッシュ一致・前回blocked)で前回の指摘内容をLLM呼び出し
  無しに再提示するために保持する(実装: `scripts/verify-claims.sh`の`write_state`/`block_with_retry_check`)
- 7日より古い状態ファイルは `doc-suggest-check.sh` と同様に自動削除する

### スキップ・再判定ロジック

現在のdiffハッシュと `last_diff_hash` を比較する:

1. **ハッシュ一致 かつ `last_verdict == "pass"`**: 何も変わっていないので検証をスキップし、即 `exit 0`
2. **ハッシュ一致 かつ `last_verdict == "blocked"`**: 前回指摘した内容が解消されないまま再度Stopしようとしている。LLM呼び出しはせず、`retry_count` を+1し、前回と同じ指摘内容で再度 `exit 2`(ブロック継続)。retry_countが上限を超えたら「ブロックしたまま人間の介入待ち」に遷移する(下記参照)
3. **ハッシュ不一致**: 差分が変化しているので検証を実行する(下記)

(2)は、「何も直さずにもう一度Stopしようとする」行為自体にリトライ予算を消費させるための設計。これがないと、コストゼロのまま無限に足踏みしてリトライ回数が進まない。

### 検証本体

- `claude -p --model claude-haiku-4-5-20251001` をサブプロセスとして起動する(低コストモデル)
- ツールは読み取り専用(Read/Grep相当)のみ許可する。Edit/Write/副作用のあるBashは許可しない(検証のはずが勝手にコードを書き換えるリスクを防ぐため)
- タイムアウトは60秒とする(Haikuモデル・読み取り専用ツールのみの軽量な検証のため、通常はこれで十分。超過した場合は「インフラ障害時の扱い」節のfail-openとして扱う)
- **`--setting-sources ""` と `--no-session-persistence` を必須で付ける。** これが無いと、このサブプロセス自身がStopイベントでStop hook一式(このverify-claims.sh自身やグローバルの通知hook等)を継承・再発火させ、子プロセスが際限なく増殖する(詳細・実際の発生経緯は「運用インシデント」節を参照)。この制約はverify-claims.shに限らず、**hookから`claude -p`を起動するあらゆる箇所に適用される一般則**であり、[`known-failure-patterns.md`](../../agents/known-failure-patterns.md)にも相互参照を残している
- 渡す入力:
  - `transcript_path` から直前の assistant ターンの抜粋(発言・編集内容の要約。トランスクリプト全体は渡さない。大きすぎるとコスト・コンテキストの両面で問題になる)
  - 現在のdiff内容
- 出力は以下のJSON形式を強制する:
  ```json
  { "findings": [ { "severity": "critical" | "important" | "minor", "description": "...", "evidence": "file:line等" } ] }
  ```
- **deny-by-default**: `severity` が欠損・不明な値の場合は `critical` として扱う(既存のAIDD Draft phaseと同じfail-open防止の方針。PR #298を踏襲)

### 判定・ブロックロジック

- findings中の最大severityを求める
- **critical/important が1件以上ある場合**:
  - `retry_count` を+1
  - `retry_count <= 3`(既存の `MAX_REVIEW_RETRIES` と同じ上限): 該当箇所の指摘内容を `stderr` に出力して `exit 2`(Stopをブロックし、VS Code側セッションに指摘を伝えて修正を促す)
  - `retry_count > 3`: ブロックしたまま人間の介入を待つ状態にする。`stderr` に「3回自動修正を試みたが解消されなかった」旨と、下記エスケープハッチの使い方を明記する
  - 状態ファイルを `{ diff_hash, verdict: "blocked", retry_count }` で更新
- **findingsが無い、またはminorのみの場合**:
  - `exit 0`。minor findingsがあれば `systemMessage` として警告のみ添える(ブロックはしない)
  - `retry_count` を0にリセットし、状態ファイルを `{ diff_hash, verdict: "pass", retry_count: 0 }` で更新

### エスケープハッチ(誤検知対策)

検証サブエージェント自身がLLMである以上、誤って `critical` と判定する可能性がある。3回のリトライを使い切って完全ブロックされた場合に人間が詰まないよう、以下を用意する:

- 人間(またはVS Code側セッション)が `.claude/.verify-state/<session_id>.skip` というマーカーファイルを作成できるようにする(小さいヘルパースクリプト、またはVS Code側セッションに依頼して touch する形でも可)
- hookはこのファイルの存在を検知したら、それを消費(削除)した上で無条件に `exit 0` とする。ログに「手動オーバーライドが使用された」旨を残す

### インフラ障害時の扱い(fail-open例外)

`claude -p` サブプロセス自体が失敗(タイムアウト・認証エラー・ネットワークエラー等)した場合、および `claude -p` は正常終了したが出力がfindingsのJSON形式として解析できなかった場合は、内容判断の deny-by-default とは別扱いにする。**この場合はfail-open(警告のみでexit 0)とする**。

理由: 「severityが不明」は検証した上での判断の曖昧さだが、「検証エージェントが動かなかった」のはツール自体の不備であり、これを理由にブロックし続けるのは開発を止めるだけで安全性に寄与しない。`systemMessage` に「検証エージェントの実行に失敗したため今回はスキップしました」と明記し、可視化はする。

## データフロー(概要)

```
Stop event
  → hookがsession_id取得、diffハッシュ計算
  → 状態ファイルと比較
      ├─ 一致 & pass → exit 0
      ├─ 一致 & blocked → retry_count+1、前回findingsで再ブロック判定
      └─ 不一致 → claude -p (Haiku, 読み取り専用) 実行
                     → findings取得、最大severity判定
                     → ブロック判定 or pass判定
  → 状態ファイル更新
  → exit code / systemMessage 出力
```

## エラーハンドリングまとめ

| ケース | 挙動 |
|---|---|
| severity欠損・不明 | critical扱い(deny-by-default) |
| critical/important、retry <= 3 | ブロック(exit 2)、指摘内容を返す |
| critical/important、retry > 3 | ブロック継続、人間の介入待ち。エスケープハッチ案内 |
| minorのみ/findingsなし | pass(exit 0)、retry_countリセット |
| 検証プロセス自体の失敗(タイムアウト等)、または出力JSONの解析失敗 | fail-open(exit 0、警告のみ) |
| `.skip`マーカーあり | 無条件pass、マーカー消費 |

## 運用インシデント(postmortem)

### Stop hook再帰発火による`claude -p`サブプロセス増殖(2026-07-14 / 2026-07-15の2回発生)

**原因:** `claude -p`で起動する検証サブプロセスが、デフォルトでsettings.json(hooks含む)を継承する。
そのため、サブプロセス自身がStopするタイミングでStop hook一式(verify-claims.sh自身・グローバルの
通知hook等)が再発火し、そのネストしたセッションもまた同じ理由で子プロセスを生む…という連鎖が発生した。

**1回目(2026-07-14):** 約15分で343個の別セッションが生成され、そのそれぞれがグローバルの通知hook
(アラート音 + 当時は`git add -A`も実行していた)を実行し続けた。「見えているウィンドウとは無関係に
アラート音が鳴り続ける」という症状として発覚した。対応として`--setting-sources ""` /
`--no-session-persistence`を追加する修正(コミット39d32b2、ブランチ`claude/keen-bohr-fcd6a0`)を
作成したが、**このブランチではPRを作成せず、コミットのみで放置した**。

**2回目(2026-07-15):** 1回目の修正がmainに未マージだったため、別のworktree
(`remaining-issues-320c09`)で全く同じ再帰が再発した。作業中のセッション自身のStopのたびに
発火しており、確認時点で常時10〜15個の`claude -p`プロセスが数秒おきに入れ替わりながら
存在していた。暴走プロセスをkillした上で、同じ修正を当該worktreeに再適用し、PR #357としてmainにマージした。

**教訓:**
1. 修正コミットを作っただけでは再発を防げない。**PRを作ってmainにマージするところまでが修正の完了条件**。
2. 通知音の抑制や`git add -A`の削除は症状(副作用)への対処であり、再帰そのもの(プロセス増殖)は止めない。
   この2つは別のインシデント対応として別途実施済み(グローバルの`~/claude_stop_notify.sh`から
   `git add -A`を削除、グローバル`settings.json`のdenyに`git add -A`/`.`/`--all`を追加)。
3. 「正しい修正が存在すること」と「その修正が実際に適用されていること」は別物であり、後者を機械的に
   保証する手段がない限り同じ事故は繰り返される(→次節「サーキットブレーカー」)。

## サーキットブレーカー

上記インシデントは、**個別の修正が正しくても、それが適用され忘れる・マージされ忘れることで
同じ事故が繰り返される**ことを示した。これに対する構造的な安全策として、以下2つを候補とするが、
**両者は防いでいる失敗モードが異なり、優先順位も異なる**ことを明記しておく。

1. **同時実行数の上限(本丸の対策)**: 「検証用`claude -p`プロセスが再帰的に増殖する」という
   今回実際に起きた失敗モードそのものを止める。例: `.claude/.verify-lock/`配下にPIDファイルを
   置き、同時に実行中の検証プロセス数が一定数(例: 3〜5)を超えたら新規起動を拒否しfail-open
   (警告のみでexit 0)する。`--setting-sources ""`のような個別修正の正しさに依存せず、
   仮に将来同種の再帰バグが別の経路で混入しても被害を頭打ちにできる。
2. **`--max-budget-usd`によるコスト上限(補完策・別の失敗モード用)**: これは「1回の`claude -p`
   呼び出しが暴走して高額課金される」という**別の失敗モード**への対策であり、今回のように
   「Haiku+短いプロンプトで1回あたりは安いが、それが大量に積み重なる」ケースには単体では
   効かない。**「予算上限さえ付ければ今回のような事故は防げる」わけではない**ことに注意。

→ 1が主・2が従。1の実装(具体的なロック機構の設計)は本ドキュメントのスコープ外とし、
別issueとして切り出す。

## ブロックループ中の他hookとの相互作用

`docs/agents/common.md`のissue #339棚卸しレビュー指摘(9/9)への対応。Stopのたびに
verify-claims / doc-suggest-check / ai-check-suggest / claude_stop_notify(通知音) /
claude_auto_issue / aidd_session_report が並走する。Claude Codeのhook実行モデル上、
**同一Stopイベント内で複数のhookは並列実行され、互いの終了コードを実行時に知る手段はない**
(hookは独立したOSプロセスであり、IPCが無い。唯一の連携手段は「前回のhook実行が書き残した
状態ファイルを、次回のhook実行が読む」という**イベントをまたいだ**形のみ)。この制約を踏まえ、
以下の方針とする:

- **初回のブロック判定**(diffハッシュ不一致→LLM呼び出し中)は、他hookが並列実行されるため
  事前に検知できない。通知音が1回鳴ることは許容する
- **リトライループ中**(diffハッシュ一致 かつ 状態ファイルの`last_verdict == "blocked"`。
  「スキップ・再判定ロジック」節の(2)のケース)は、この状態が**前回のStopイベントで既に
  書き込み済み**であるため、今回のStopイベントの開始時点で他hookから読み取り可能。
  よって `claude_stop_notify.sh` / `claude_auto_issue.sh` は起動時に、cwd配下の
  `.claude/.verify-state/<session_id>.json` を読み、現在のdiffハッシュ(既存のverify-claims.sh
  と同じ計算方法)が `last_diff_hash` と一致し `last_verdict == "blocked"` であれば、
  通知音・auto_issue処理をスキップする
- この判定ロジックはグローバルスクリプト側(`~/claude_stop_notify.sh`、`~/claude_auto_issue.sh`)
  に実装する必要がある。`verify-claims.sh`が存在しない/未実行のプロジェクトでは状態ファイルも
  存在しないため、従来通りの挙動になる(後方互換)
- 実装(グローバルスクリプトの変更)は本ドキュメントのスコープ外とし、別issueとして切り出す

## テスト方針

`scripts/` 配下に既存のテスト基盤が無いため、新規に簡易テストを用意する:

- 合成したhook入力JSON(`{"session_id": "test-xxx"}`)を標準入力で渡し、`scripts/verify-claims.sh` を直接実行する
- 検証対象のシナリオ:
  1. diff無し → 即pass
  2. diff一致・前回pass → 即pass(LLM呼び出しが発生しないこと)
  3. diff一致・前回blocked → LLM呼び出し無しでretry_count+1、再ブロック
  4. diff不一致・critical finding → ブロック、状態ファイルにblocked+retry_count記録
  5. retry_countが3を超える → ブロック継続、エスケープハッチ案内が出力に含まれる
  6. `.skip`マーカーあり → 無条件pass、マーカーファイルが削除される
  7. 検証プロセス自体が失敗(モック) → fail-openでpass
  8. 同時実行数が上限に達している → サーキットブレーカーでfail-open(LLM呼び出し無し)
  9. **(issue #352)** untrackedファイルのみ追加・修正 → ハッシュが変わり再検証される(新規ファイル追加時に1回、その後中身を書き換えたときにもう1回、計2回LLM呼び出しが発生すること)
- `claude -p` 呼び出し部分は実行コストがかかるため、テストではモック(固定のfindings JSONを返すダミースクリプト)に差し替えて検証する

## 対象範囲外(YAGNI)

- Stop以外のhookイベント(PreToolUse等)への拡張は今回のスコープ外
- CLIセッション(Claude Code CLI)側への同様の仕組みの導入は行わない(CLIはアドバイスのみの方針を維持)
- severity分類自体のチューニング(閾値の精度向上等)は運用開始後の継続課題とする

**検証の網羅性は保証しない。** Haikuモデル・トランスクリプトの抜粋(直前ターンのみ)・60秒の
タイムアウトという軽量な構成であるため、偽陰性(本来指摘すべき問題を見逃す)は普通に起こり得る。
このhookを通過した(exit 0で終わった)ことは「その変更が正しいことの証明」ではなく、「明らかな
主張齟齬・粗い見落としを減らすための軽量フィルタを1つ通過した」という意味でしかない。人間による
レビュー・既存のテスト/lint/型チェックの代替にはならない。
