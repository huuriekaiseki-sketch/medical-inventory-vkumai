# <リポジトリ名> の AI エージェント設定（導入先アダプター）

AIDD パイプラインは `aidd-core` / `aidd-vkumai` プラグインから提供される。固有の値は `aidd.config.json`。

## プロジェクト設定
- テストコマンド: <aidd.config.json の commands.test と同じ>
- Lint コマンド: <commands.lint>

## フロー（骨格）
Phase 1 調査 → Phase 2 仕様書 → [停止① 人間レビュー] → Phase 3 実装 → Phase 4 統合ゲート → Phase 5 検証 → [停止② 構造化レビュー]

## Workflow の呼び方（名前はプラグイン名で修飾する）
- Phase 1 入口: `Workflow({ name: 'aidd-phase1-router', args: { taskDescription, changedFiles } })`
  （このリポジトリの wrapper。`aidd.config.json` の risk を渡して `aidd-vkumai:aidd-phase1-router` を呼ぶ）
- 直接呼ぶ場合: `aidd-vkumai:aidd-phase1` / `aidd-vkumai:aidd-1-1-deep-task` / `aidd-vkumai:aidd-phase2`
- エージェント: `aidd-core:reviewer` / `aidd-vkumai:sweep-ui` など

## 作る前に聞く（値を勝手に決めない）

新しい表・API・外部送信を作る前に、**大きさ（文字数・件数）／量（何回まで）／権限（誰が読み書き）／
消えるとき／記録（成功と失敗）／途中で止まったら／外に出るもの**を人に聞く。
分からない値を既定値で埋めない。聞いた答えは `aidd.config.json` の `limits` に書き、
migration や route の先頭に `-- design:` / `// design:` で残す。

`limits` が雛形のままだと `check-design-answers.test.sh` が落ちる。これは不具合ではなく、
**人に聞くまで先へ進ませないための仕掛け**（後から点検で見つけると作り直しになるため）。

## 絶対ルール
- 確認を求めるのは停止①と停止②の 2 箇所のみ。それ以外は止まらず進める
- 停止①: 仕様書を提示したら承認まで Phase 3 へ進まない
