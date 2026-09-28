# aidd-codex-vkumai 0.1.3: marketplace 初掲載と発火の実測

実施日: 2026-09-28。Codex CLI 0.147.0。marketplace `huuriekaiseki-sketch/aidd-plugins` の `bc49596`（0.1.3。中心リポジトリ main `44c3d244` から生成、タグ `aidd-codex-vkumai--v0.1.3`）。検証用リポジトリは `/Users/masanori/雑談/aidd-codex-verify`（`verify/merged-head`、クリーン、`.ts` も `.codex/` も無い）。

## 導入

1. `codex plugin marketplace upgrade aidd-plugins --json` → `errors: []`。導入済みの `aidd-codex` は 0.1.3 に入れ替わり（0.1.2 の記録と同じ挙動）、`config.toml` の `trusted_hash` 4 件は更新前と同一、`enabled = true` 維持。
2. `codex plugin list --marketplace aidd-plugins --json` は `installed` に `aidd-codex` 0.1.3 のみ、**`available: []`**（カタログに `aidd-codex-vkumai` があるのに一覧に出ない）。理由は未確認。
3. `codex plugin add aidd-codex-vkumai@aidd-plugins --json` → 成功。`version: 0.1.3`、`installedPath: ~/.codex/plugins/cache/aidd-plugins/aidd-codex-vkumai/0.1.3`。キャッシュは配布物と `diff -r` で同一。`config.toml` に `[plugins."aidd-codex-vkumai@aidd-plugins"] enabled = true` が増え、`hooks.state` にはこのプラグインの行が無い（＝未信頼）。

## 発火（信頼前と、信頼相当）

`/hooks` での信頼操作は CLI から行えないため、信頼した状態の代わりに `codex exec --dangerously-bypass-hook-trust`（信頼記録を見ずに有効な hook を実行するフラグ）で hook の動作だけを測った。**信頼の操作そのものは測っていない**（人が `/hooks` で行う）。同じフラグで他プラグインの未信頼 hook 2 本も動きうるが、その出力は今回の判定に影響しない。

| 操作 | 未信頼（対照） | 信頼相当（bypass） |
| --- | --- | --- |
| `psql --version` をシェルで実行させる（`-s read-only`、`-m gpt-5.5`） | 実行された（`exit 127`、psql 不在）。止まっていない | **`Command blocked by PreToolUse hook`**。理由は `check-direct-ddl-execution.sh` の「supabase db execute・psql の直接実行は…禁止」。セッション `01a0e609-ba0e-…` |
| `src/probe.ts`（未追跡）を置いたまま「ok」とだけ返答させ、品質チェックを打たずに終了 | 未実施 | Stop hook `codex-ai-check-suggest.sh` が実行され、検証用 clone に `.codex/.ai-check-suggest-state/`（hook が `mkdir -p` する状態ディレクトリ）がセッション終了時刻で作られた。**警告文そのものは `codex exec --json` のイベントにも保存記録（rollout）にも出ない**（Stop hook の systemMessage は exec モードでは観測できない）。対話 CLI での表示は未検証 |

`codex-dependency-change-deny.sh` と `codex-ai-check-track.sh` は今回発火させていない（前者は `npm install <pkg>` を打たせる必要があり、後者は `npm run typecheck` 等を打つ必要がある。検証用リポジトリに package.json が無いため今回は見送り。判定本体は `check-dependency-change.test.sh` と `codex-ai-check.test.sh` がプラグイン内のコピーに対して通っている）。

## 後始末

`src/probe.ts`・`src/`・`.codex/`（いずれも測定で増えたもの）を削除し、`git status --short` が空。個人環境には `aidd-plugins` marketplace、信頼済み `aidd-codex` 0.1.3、**未信頼の `aidd-codex-vkumai` 0.1.3** を残した。使う場合は `/hooks` で 4 本を信頼する。解除は `codex plugin remove aidd-codex-vkumai@aidd-plugins`。

## 未検証

- `/hooks` での信頼操作と、信頼後の発火（bypass 無し）。
- Stop hook の警告文が対話 CLI に表示されるか（exec では観測不能）。
- `codex-dependency-change-deny.sh` / `codex-ai-check-track.sh` の実発火。
- `codex plugin list` の `available` に新プラグインが出なかった理由。
- Codex CLI 0.158 系、ChatGPT desktop app。
