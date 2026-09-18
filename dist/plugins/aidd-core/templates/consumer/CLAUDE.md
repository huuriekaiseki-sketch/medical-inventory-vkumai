# <リポジトリ名> の AI エージェント設定（導入先アダプター）

AIDD パイプラインは `aidd-core` / `aidd-vkumai` プラグインから提供される。固有の値は `aidd.config.json`。

## プロジェクト設定
- テストコマンド: <aidd.config.json の commands.test と同じ>
- Lint コマンド: <commands.lint>

## フロー（骨格）
Phase 1 調査 → Phase 2 仕様書 → [停止① 人間レビュー] → Phase 3 実装 → Phase 4 統合ゲート → Phase 5 検証 → [停止② 構造化レビュー]

## Workflow の呼び方（名前はプラグイン名で修飾する）
- Phase 1 入口:
  `Workflow({ name: 'aidd-vkumai:aidd-phase1-router', args: { taskDescription, changedFiles, riskConfig } })`
  （`riskConfig` は `aidd.config.json` の `risk` と同じ値。Workflow は導入先のファイルを読めないので**呼ぶ側が渡す**）
- **wrapper Workflow を作らない。** wrapper → router → phase1 で入れ子が 2 段になり、
  エージェントを 1 体も起動しないまま失敗する（2026-09-12 実測）
- 直接呼ぶ場合: `aidd-vkumai:aidd-phase1` / `aidd-vkumai:aidd-1-1-deep-task` / `aidd-vkumai:aidd-phase2`
- エージェント: `aidd-core:reviewer` / `aidd-vkumai:sweep-ui` など

## 作る前に聞く（値を勝手に決めない）

新しい表・API・外部送信を作る前に、**大きさ（文字数・件数）／量（何回まで）／権限（誰が読み書き）／
消えるとき／記録（成功と失敗）／途中で止まったら／外に出るもの**を人に聞く。
分からない値を既定値で埋めない。聞いた答えは `aidd.config.json` の `limits` に書き、
migration や route の先頭に `-- design:` / `// design:` で残す。

`limits` が雛形のままだと `check-design-answers.test.sh` が落ちる。これは不具合ではなく、
**人に聞くまで先へ進ませないための仕掛け**（後から点検で見つけると作り直しになるため）。

## 検査を作る前に「型」を読む

新しい検査・仕組みを作る前に `docs/agents/check-design-pitfalls.md`（C-xxx）を読む。
**検査そのものを設計するときの間違え方**が 12 の型で並んでいる
（印を実態と突き合わせない／「何かが起きた」を成功と読む／不在で判定するのに出る側の対を置かない／
壊して落ちることを確かめない／後片付けの範囲が広すぎる など）。

どれも「テストは緑のまま」潜むので、**作った本人がいちばん気づけない**。
型はどのリポジトリでも同じ形で出るのでプラグインが配るが、
**実例と守るテストは自分のリポジトリのもの**。実際に踏んだら日付つきで 1 行足し、
止める検査を作ったら状態を `検知あり` にしてパスを書く。

## 絶対ルール
- 確認を求めるのは停止①と停止②の 2 箇所のみ。それ以外は止まらず進める
- 停止①: 仕様書を提示したら承認まで Phase 3 へ進まない
