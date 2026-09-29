# Codex のセッション開始時の入口（`codex-session-start.sh`）の実機確認

実施日: 2026-09-30。中心リポジトリ `08d77121`（PR #868）。Codex CLI 0.147.0。仕様書は [`docs/specs/codex-hook-parity/07-claude-only-hooks.md`](../../../specs/codex-hook-parity/07-claude-only-hooks.md)。

この入口はプラグインでは配っていない（リポジトリの `.codex/hooks.json` にだけ登録している）。記録の置き場所は、ほかの Codex の実機確認と揃えた。

対話 CLI の操作（起動・`/hooks` の確認・信頼）は、人が行った。こちら（Claude Code 側）が行ったのは、設定ファイルとセッションの記録の読み取りだけで、設定の変更と信頼の操作はしていない。`--dangerously-bypass-hook-trust` は使っていない。

## 結論

| 確かめたかったこと | 結果 |
| --- | --- |
| 入口が Codex から発火するか | **発火する。** 4 件の知らせが、追加コンテキストとして会話に入った |
| 知らせが、人の見る画面に出るか | **出ない。** 再起動の直後も `/clear` の後も、画面には何も出なかった |
| 入口を足したとき、既存の hook の信頼は保たれるか | 保たれる見込み（信頼の記録は「ファイルのパス・イベント・組の番号・組の中の番号」で持たれ、末尾に足した入口は `session_start:0:3`）。ただし、リポジトリ側の既存 8 件はもともと信頼されておらず、保たれたことを直接は見ていない |
| 普段の作業場所で動くか | **動かない。** リポジトリの `.codex/hooks.json` が読み込まれていない（下の「分かったこと 1」） |

## 経過

| 回 | 場所 | 観察 |
| --- | --- | --- |
| 1 | `~/.codex/worktrees/codex-hook-trust/medical-inventory-vkumai`（`08d77121` の worktree） | `/hooks` に入口が出ない。`claude-mem@claude-mem-local` の 2 件に `Modified since last trusted - review required`。信頼の操作はしなかった |
| 2 | 同上 | フォルダの信頼確認が出ない。Source がリポジトリの `.codex/hooks.json` の hook は 1 件も無く、出ているのはプラグイン由来だけ（二重の登録なし）。設定の件数は前後で変わらず（信頼済みのプロジェクト 85、hook の信頼の記録 62） |
| 3 | 信頼済みの親フォルダの外に作った clone（`08d77121`、`/private/tmp` 配下） | フォルダの信頼確認が出た。信頼すると、リポジトリの `.codex/hooks.json` が `/hooks` に読み込まれ、入口は `New hook - review required`。Source と command を照合して、入口の 1 本だけ信頼した。同じ点検の、リポジトリ側とプラグイン側の登録が両方表示された |

1 回目の `claude-mem` の 2 件は、この確認とは関係が無い。`claude-mem` のキャッシュが 2026-09-29 23:23 に `13.25.3` へ更新されており、PR #868 のマージ（2026-09-30 7:27）より前だった。

## 3 回目の後の設定の差（`~/.codex/config.toml`）

増えたのは次の 2 行だけ。減った行は無い。

| 節 | 値 |
| --- | --- |
| `[projects."<clone>"]` | `trust_level = "trusted"` |
| `[hooks.state."<clone>/.codex/hooks.json:session_start:0:3"]` | `trusted_hash = "sha256:903c4173…"` |

## 発火の根拠（セッションの記録）

セッション `01a0ef5f-ccca-7510-a33f-d25d56404dfd`（開始 2026-09-30 7:53:48、作業場所は 3 回目の clone）。最初のターンの開始（7:54:21）に、`developer` の発言として次の 2 つが入っていた。

1 つ目（354 文字。入口が出したもの）:

```
統合テストを通した記録が 1 件もありません。`bash scripts/run-integration-tests.sh` で回すと結果が記録され、次から鮮度を見られます。

E2Eを通した記録が 1 件もありません。`bash scripts/run-e2e-tests.sh` で回すと結果が記録され、次から鮮度を見られます。

認可ポリシーの変異計測（RLS）を通した記録が 1 件もありません。`bash scripts/check-rls-mutation.sh` で回すと結果が記録され、次から鮮度を見られます。

製品コードの変異計測を通した記録が 1 件もありません。`bash scripts/run-mutation-tests.sh` で回すと結果が記録され、次から鮮度を見られます。
```

2 つ目（177 文字）は、プラグイン（`aidd-codex`）から動いた `check-local-main-freshness.sh` の知らせで、入口とは別の hook。

1 つ目は、同じ clone で入口を直接起動したときの出力（4 件）と同じ。clone には計測の記録（`logs/`）が無いので、「記録が 1 件もありません」の側の文面になる。普段の作業場所で直接起動したときは、3 件が「直近に通したときから中身が変わっています」の側の文面で出た（PR #868 の実測）。

4 件は空行で区切られ、1 つの発言にまとまっている。入口が、点検ごとの出力を 1 つにまとめていることと合う。

## 分かったこと

### 1. 信頼済みのフォルダの下では、リポジトリの hook が読み込まれない

公式の説明は「Project-local hooks load only when the project `.codex/` layer is trusted」。この個人環境では `/Users/masanori` が信頼済みで、その下のフォルダでは、信頼の確認が出ない。しかし、リポジトリの `.codex/` の層は読み込まれなかった。

| 場所 | 信頼の確認 | リポジトリの hook |
| --- | --- | --- |
| `/Users/masanori` の下（信頼の記録が無い worktree） | 出ない | 読み込まれない |
| `/private/tmp` の下（信頼済みの親が無い） | 出る | 信頼すると読み込まれる |

過去に、リポジトリの `.codex/hooks.json` の信頼の記録が残っている場所は、どれも `/private/tmp` の下の clone だった。普段の作業場所（`/Users/masanori/medical-inventory-vkumai` と、その下の worktree）の記録は 1 件も無い。

**これまで「信頼済みの 8 件」と呼んでいたのは、プラグイン（`aidd-codex` 4 件・`aidd-codex-vkumai` 4 件）の hook で、リポジトリの `.codex/hooks.json` の hook ではなかった。** 普段の作業場所では、同じスクリプトがプラグインから動いていたので、止まるべきものは止まっていた。

確かめていないこと: 確認に使った worktree は `~/.codex/` の中にあり、`.git` がファイル（worktree）だった。読み込まれなかった理由がこのどちらかである可能性は、切り分けていない。明示的に信頼済みの `/Users/masanori/medical-inventory-vkumai` で `/hooks` を開いたときに、リポジトリの hook が出るかも見ていない。

### 2. セッション開始時の知らせは、モデルには届くが、人の画面には出ない

入口は `systemMessage` と `hookSpecificOutput.additionalContext` の両方に同じ文を入れている。Codex CLI 0.147.0 の対話画面では、セッション開始時の `systemMessage` は表示されなかった。`additionalContext` は、最初のターンの開始時に会話へ入る。

Claude Code では、同じ知らせが人の画面にも出る。Codex では、人は知らせを見ず、モデルだけが受け取る。

### 3. 信頼の記録は、位置で持たれている

記録の鍵は `<hooks.json のパス>:<イベント>:<組の番号>:<組の中の番号>`。入口は SessionStart の組の末尾に足したので `session_start:0:3` になった。途中に足すと、後ろの hook の番号がずれる。ずれたときに信頼がどうなるかは見ていない。

## 確かめられなかったこと

| 項目 | 理由 |
| --- | --- |
| モデルが、受け取った追加コンテキストを読めているか | 会話で確かめようとしたが、CLI の設定のモデルがアカウントで使えないというエラー（400）で、応答が返らなかった。記録に追加コンテキストが入っていることは確認した |
| 普段の作業場所での発火 | リポジトリの hook が読み込まれないため |
| 時間切れ・起動できない点検があるときの知らせ | 実機では起こしていない（テストで確認している） |
| desktop app、CLI 0.158 系 | 測っていない |

## 後片付け

- 個人設定に、3 回目の clone の信頼の記録が 2 行残っている（上の表）。clone はセッションの一時フォルダにあり、消えても設定の行は残る。消すかどうかは人が決める
- 1 回目・2 回目の worktree（`~/.codex/worktrees/codex-hook-trust/`）は、Codex 側で作られたもので、こちらでは触っていない
