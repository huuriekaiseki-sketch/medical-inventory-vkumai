# aidd-codex-vkumai 0.1.3: 信頼後の実発火とカタログ表示

実施日: 2026-09-28。中心リポジトリ `8446d284`、marketplace `huuriekaiseki-sketch/aidd-plugins` の `bc49596`、Codex CLI 0.147.0（モデル `gpt-5.5`）。検証用 clone は `/Users/masanori/雑談/aidd-codex-verify` の `verify/merged-head`。開始時の `git status --short` は空。個人設定の変更は事前承認を得て実施した。`--dangerously-bypass-hook-trust` は使っていない。

## `/hooks` での信頼

新規の対話 CLI で `/hooks` を開くと、`aidd-codex-vkumai@aidd-plugins` 由来の4本はそれぞれ `New hook - review required` と表示された。Source と command を1本ずつ確認してから個別に信頼した。

| Event | Command のスクリプト |
| --- | --- |
| PreToolUse | `check-direct-ddl-execution.sh` |
| PreToolUse | `codex-dependency-change-deny.sh` |
| PostToolUse | `codex-ai-check-track.sh` |
| Stop | `codex-ai-check-suggest.sh` |

信頼後、`~/.codex/config.toml` の `hooks.state` に対象プラグインの `pre_tool_use:0:0`、`pre_tool_use:1:0`、`post_tool_use:0:0`、`stop:0:0` の4行ができ、いずれも `trusted_hash` があった。別プラグイン由来の信頼待ち2本は操作していない。

## bypass 無しの発火

| 操作 | 観測 |
| --- | --- |
| 新規 `codex exec -m gpt-5.5 --json -s read-only` で `psql --version` を1回だけ呼ばせる | セッション `01a0e61b-7024-7422-8b5a-191304e2b663` の rollout に `exec_command` の呼び出し1件と `Command blocked by PreToolUse hook: supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。… Command: psql --version` が残った。再試行は無し。 |
| `src/probe.ts` を未追跡で置く（内容 `export const probe = 1`）。新規の対話 CLI セッションでツールを使わず `ok` と返答させる | `ok` の直後、**対話画面**に次の Stop 警告が表示された。前回の `codex exec --json` では観測できなかった表示経路を確認した。 |
| 同じ対話セッションで `npm run typecheck` を1回だけ呼ばせる | `package.json` 不在で `ENOENT`（exit 254）。それでも PostToolUse は `.codex/.ai-check-suggest-state/01a0e61c-5333-78f3-ba57-e59c19b314d9.hash`（65 bytes）を書いた。直後の Stop では上記の品質チェック警告は出なかった。これは「コマンドを打った」ことの記録であり、チェック成功の証拠ではない。 |

画面に出た Stop 警告の全文:

```text
[Codex] ソース（.ts / .tsx / .sql）を変えていますが、このセッションで品質チェックを打った形跡がありません。
打っていれば、その後に触った分だけが残っています。
  npm run typecheck / npm run lint / npm test
  まとめて: npm run ai:check（統合テストと E2E まで通すので数分かかります）
```

対話画面には別途 `Stop hook (failed): hook exited with code 1` も表示された。上記 AIDD の警告が表示されたことと、`.hash` の作成・次回の警告抑制を確認した範囲を成功として記録する。この失敗表示の発生元は今回特定しておらず、他の hook の成功まで主張しない。

## `available` の再現

`codex plugin remove aidd-codex-vkumai@aidd-plugins` のあと、`codex plugin list --marketplace aidd-plugins --json` を1回実行した。`installed` には `aidd-codex` 0.1.3 だけがあり、**`available: []`**。marketplace のカタログには `aidd-codex-vkumai` があるため、未導入でも表示されない現象を再現した。原因は未解明。

直後の `codex plugin add aidd-codex-vkumai@aidd-plugins` は成功した。`config.toml` で `enabled = true` と対象4本の `trusted_hash` が維持された。再起動した対話 CLI の `/hooks` は信頼待ちが引き続き別プラグインの2本のみで、対象4本の再信頼は不要だった。

## 後始末と残す状態

測定で作った `src/probe.ts`・`src/`・`.codex/` を削除し、検証用 clone の `git status --short` が空であることを確認した。個人環境には `aidd-plugins` marketplace、信頼済みの `aidd-codex` 0.1.3 と `aidd-codex-vkumai` 0.1.3 を残した。生成器・hook 定義・marketplace の内容は変えていない。

未検証: `codex-dependency-change-deny.sh` の実発火、`available: []` の原因、CLI 0.158 系および desktop app での同じ挙動。
