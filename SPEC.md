# SPEC: issue #652 subagent frontmatter新フィールド導入 — 実機検証に基づく確定版

プロダクトコードに触れないメタ改修。Phase 1調査+実機検証2回の結果、issue原案の3要素のうち
**実施は1点に縮小し、2点は実測根拠付きで見送る**方針とする。

## Part 1 — 仕様(★人間がレビューする部分)

### 結論サマリ

| issue #652の要素 | 判断 | 決め手(すべて実測・実ファイル確認) |
|---|---|---|
| `skills:`プリロード | **見送り** | known-failure-patterns.mdはCodex側(`.agents/skills/handoff-format`)からも参照される**ツール中立の共有資産**。スキル化=`.claude/skills/`への移動はClaude/Codex共存設計違反、複製は二重管理(ドリフト温床)になる |
| `permissionMode: plan` | **見送り** | sweep-uiに一時設定して実機検証した結果、**書き込み3種(ログスクリプト追記・`>`リダイレクト・mkdir)がすべて素通り**し、ファイル実体の作成を確認した。read-onlyの機械強制にならず、「強制済み」という誤った安心感だけが増える |
| `maxTurns` | **延期** | sweep系は「対象ファイル全件列挙→全件Read」の決定的手順のため、対象30ファイル超で正常動作を打ち切る。打ち切られた空応答は「指摘なし」と区別不能で、静かな見逃しモードを新設してしまう。turns実測(baselinesへの追加)が先 |
| (調査で発見した穴) | **実施** | `sweep-db.md`だけが既知失敗パターン集への参照を持たない。RLS担当なのに「RLS/テナント分離層」セクション(issue #24再発防止)と繋がっていないため、sweep-ui/dataと同型の参照節を追加する |

### 何が変わるか

- sweep-db(DB層調査エージェント)が、調査時に「RLS/テナント分離層」の既知失敗パターン
  (認可チェック漏れ・SECURITY DEFINERの取り残し等、過去に実際に起きたミス)を必ず
  チェックリストとして確認するようになる
- それ以外のエージェントの挙動・フローの使い方は一切変わらない

### 受け入れ条件

- [ ] `sweep-db.md`に「## 既知の失敗パターン」節が追加され、対象セクションが
      「RLS/テナント分離層」(および関連の深い「データ取得層/API層」のSECURITY DEFINER項)である
- [ ] `sweep-types.md`には追加しない(known-failure-patterns.mdに型整合性セクションが
      存在しないため。将来セクションが増えたら追随)
- [ ] 見送り2件+延期1件の判断と実測結果が`docs/agents/tooling-decisions.md`に記録されている
      (再評価トリガー: 公式がplanのBash強制を強化したら/baselinesにturns実測が入ったら)
- [ ] issue #652に調査結果をコメントしてクローズする
- [ ] `npm test`が通る(frontmatterは変更しないためbaselineスナップショット義務は非発生)

## Part 2 — 実装計画(AI用・レビュー不要)

### 実装セット(依存なし、1波)

1. `sweep-db.md`: sweep-data.mdと同型の「## 既知の失敗パターン」節を調査対象の直前に挿入。
   参照セクション=「RLS/テナント分離層」+「データ取得層/API層」のSECURITY DEFINER 2項
2. `docs/agents/tooling-decisions.md`: 見送り記録エントリを追加(既存の「Bashサンドボックス
   保留(issue #438)」等と同型式)。permissionMode検証の実測手順・結果(3種素通り)、
   skillsプリロードのアーキテクチャ理由、maxTurns延期理由と再評価条件を記載
3. issue #652へのコメント+クローズ(gh issue comment / gh issue close --reason completed。
   sweep-db穴埋めを実施した上でのスコープ縮小クローズ)

frontmatter(model/effort行)は変更しないため、check-agent-baseline-freshness.shの
baseline更新警告は発生しない。プロンプト本文のみの変更で、`.claude/workflows/`にも
触れないためeval義務も非発生。

### テスト観点

- `npm test`(プロンプト同期テスト群を含む)がgreenのまま
- sweep-db.mdの追加節がsweep-ui/dataの既存節と同型式であること(目視)

## Part 3 — 仕様レビュー前セルフチェック(AI用・レビュー不要)

新しい型・enum・statusフィールドの導入なし。包含/除外リストは結論サマリ表の4行のみで、
本文と件数一致(実施1・見送り2・延期1)。既存判定ロジックの置き換えなし。全項目非該当を確認。
