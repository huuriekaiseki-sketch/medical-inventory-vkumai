# 検証サブエージェント(Stop hook自動裏取り) 設計

## 背景・目的

2026-07-11、issue #41/#42/#165のレビューで、CLIセッション(Claude Code CLI)が担っていた「主張の裏取り役」(行番号・既存コード挙動・環境変数名の一致等をgrepで確認する)を、VS Code側セッション内に自動組み込みする方針で合意した([[project_verification_subagent]])。

VS Code側で実装 → スクリーンショットをCLIセッションに貼って質問 → CLI側がgrepで裏取りして指摘 → VS Code側で修正、という往復を人間が手動で仲介する煩雑さを無くすことが目的。無くすべきは「人間が2セッション間を手動で仲介する部分」であり、検証プロセス自体ではない。

対象は `medical-inventory-vkumai` リポジトリ(VS Code側のセッション)。CLIセッションはアドバイスのみに徹する方針([[feedback_cli_advisory_only]])のため、この検証サブエージェントもVS Code側での自動実行が前提。

## アーキテクチャ

### 発火の仕組み

- Stop hookとして `scripts/verify-claims.sh` を追加する(既存の `scripts/doc-suggest-check.sh` と並走)
- hookのJSON入力から `session_id` を取得する(既存の `doc-suggest-check.sh` と同じ形式)
- `git diff HEAD` + `git status --porcelain` を連結した内容のSHA256ハッシュを「現在のdiffハッシュ」として計算する(既存パターンを流用)
- 状態は `.claude/.verify-state/<session_id>.json` に保存する:
  ```json
  { "last_diff_hash": "...", "last_verdict": "pass" | "blocked", "retry_count": 0 }
  ```
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
- `claude -p` 呼び出し部分は実行コストがかかるため、テストではモック(固定のfindings JSONを返すダミースクリプト)に差し替えて検証する

## 対象範囲外(YAGNI)

- Stop以外のhookイベント(PreToolUse等)への拡張は今回のスコープ外
- CLIセッション(Claude Code CLI)側への同様の仕組みの導入は行わない(CLIはアドバイスのみの方針を維持)
- severity分類自体のチューニング(閾値の精度向上等)は運用開始後の継続課題とする
