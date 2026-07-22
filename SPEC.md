# SPEC: journal.jsonlのresultをverify-agent-progress-transcriptの突合にも統合する（issue #493 残スコープ）

- issue: #493
- feature名: `issue-493-journal-result-integration`
- baseCommit: `460514d15c306ecb4c0e3fb0a36dbd755cb0075a`
- 作成日: 2026-07-22

## Part 1: 背景・スコープ確定の経緯（★人間がレビューする部分）

issue #493の「やること」1〜3（`scripts/lib/reconstruct-loop-observability.ts`への
journal.jsonl優先分岐・フォールバック・unit test）は、**issue #462のPR #467
（2026-07-18マージ、コミット`eba2c10`）で既に実装済み**であることをコード・テスト・
マージ履歴で確認した。issue #493（2026-07-21起票）は`docs/agents/common.md`の
「組み込みは未着手」という陳腐化した記述を根拠にしていたため、実装済み分が
重複起票されている。

したがって本仕様のスコープは以下の2点のみ:

1. **「やること」4（未実装分）**: `scripts/lib/verify-agent-progress-transcript.ts`の
   `loadTranscripts`に、journal.jsonlのresult優先取得ロジックを統合する
2. **ドキュメント訂正**: `docs/agents/common.md`「第4の記録層の候補」節の
   「組み込みは未着手（別issueで検討）」記述を実態（実装済み）に合わせて更新する

### Phase 1 Sweepの指摘との対応

- types軸「loadTranscriptsがjournal.jsonl統合ロジックを実装していない」→ 本仕様の主対象
- types軸「common.md行214-225の陳腐化記述」→ 本仕様で更新
- types軸「TranscriptRecordにfindingsフィールドが無い」「model/promptTextを無視」→
  **対応しない**（下記「対応しないこと」参照）
- db/data/ui軸の指摘 → すべて本issueと無関係な既存コードへの一般指摘のためスコープ外
  （dbの既知指摘は既存issue群・decisions.mdの管理範囲）

## Part 2: 変更内容

### 2-1. `scripts/lib/reconstruct-loop-observability.ts`

- 既存のモジュール内private関数 `loadJournalResults(wfDirPath, filenames)` を
  **`export`に変更する（ロジック変更なし）**。verify側から同一ロジックを再利用するため。
  - 二重実装（インライン複製）を避ける。同一プロセスのNode/vitestから使うため
    Workflow DSLのimport制約は無関係であり、通常のimportでよい。

### 2-2. `scripts/lib/verify-agent-progress-transcript.ts`

- `loadTranscripts(projectDir)` 内で、各`wf_*`ディレクトリ処理時に
  `loadJournalResults(wfDir, filenames)` を呼び、該当`agentId`の構造化result
  （`status`が`pass|fail|blocked`のもの）があれば `TranscriptRecord` の
  `status`/`detail` をjournal側の値で上書きする。無いagentIdは従来どおり
  `parseAgentTranscriptLines`の結果のまま（フォールバック維持）。
- `endTimestamp`は従来どおりtranscript側から取得する（journal.jsonlには
  タイムスタンプが無いため。時刻近接突合`matchRecords`のロジックは一切変更しない）。
- 効果: `compareStatus`/`compareDetail`が参照するstatus/detailの源泉が、
  transcript最終メッセージのパース（StructuredOutputブロック探索）から、
  Workflowツールが機械的に書き出したresultへ置き換わり、突合の意味判定の
  精度・堅牢性が上がる（transcript形式変化への耐性・パース失敗時のnull回避）。

### 2-3. `scripts/lib/verify-agent-progress-transcript.test.ts`

以下のケースを追加（既存の`loadTranscripts`系テストのfixture方式に合わせる）:

1. journal.jsonlに該当agentIdの構造化resultがある場合、`TranscriptRecord.status/detail`
   がjournal側の値になる（transcript側と異なる値で検証）
2. journal.jsonlが存在しない場合、従来のtranscriptパース結果のまま（回帰確認）
3. journal.jsonlはあるが該当agentIdの行が無い／resultがプレーン文字列の場合、
   そのagentはtranscriptパース結果へフォールバックする

### 2-4. `docs/agents/common.md`

- 「第4の記録層の候補（issue #442調査、未実装）」節を「実装済み」の記述に更新:
  - reconstruct側の組み込みはissue #462（PR #467）で実装済み
  - verify側（本issue #493）の組み込みも実装済み
  - 「journal.jsonlはWorkflow経由でのみ生成される」「keyはハッシュのみで
    agentType/feature復元にはtranscript/meta.jsonが必要」という制約の記述は維持

## 並列グループ宣言

- **グループ1（単独・並列化なし）**: 2-1〜2-4すべて。変更ファイル4つは相互依存
  （exportの追加→import→テスト→ドキュメント）のため、implementer 1体で直列実装する。

## 受け入れ条件

- journal.jsonlがあるWorkflow実行分の`TranscriptRecord`で、status/detailが
  transcriptパースなしにjournal由来の値になる（unit testで検証）
- journal.jsonlが無い場合（Agent tool直接起動）の従来動作が維持される（unit testで検証）
- `npm test` green / `npm run lint` green
- `matchRecords`の突合アルゴリズム（時刻近接・貪欲割り当て）に挙動変化が無い

## 対応しないこと（明示的スコープ外）

- `TranscriptRecord`への`findings`/`model`/`promptText`フィールド追加:
  検証ロジック（`compareStatus`/`compareDetail`）が参照しないため追加しない（YAGNI）
- `JournalResultPayload`のキャスト改善: 既存コードの型スタイルであり実行時検証で
  補完済み。本issueのスコープ外
- Phase 1 Sweepのdb/data軸指摘（既存マイグレーション・API層への一般指摘）: 本issueと無関係
- DB・データ取得層・UI・RLS・migrationには一切触れない
