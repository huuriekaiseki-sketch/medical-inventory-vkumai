# Codex 用プラグイン 0.1.1 → 0.1.2: 版を変えた更新の実測

実施日: 2026-09-28。Codex CLI 0.147.0。marketplace は `huuriekaiseki-sketch/aidd-plugins` の `6bcaeea`（0.1.2。中心リポジトリ main `f375e56d` から生成、タグ `aidd-codex--v0.1.2`）。導入済みの状態は [前回の記録](2026-09-28-marketplace-verify.md) のまま（`aidd-codex@aidd-plugins` 0.1.1、4 本を信頼済み）。`hooks/hooks.json` は 0.1.1 から不変。

## 測りたかったこと（RELEASE.md §7 の 2・3・4）

1. `policy` / `category` が無いカタログで `add` が通るか
2. 版を変えたとき、remove 無しで新版に入れ替わるか
3. 版を変えたあとも `trusted_hash` が維持され、hook が再信頼なしに発火するか

## 1. `policy` / `category` 無し（0.1.2 配布前に実施）

- 一時 marketplace `aidd-nopolicy-tmp` を local path で作った。`.agents/plugins/marketplace.json` のエントリは `name` / `description` / `source`（`local` + `./plugins/aidd-codex`）だけ。中身は 0.1.1 の配布物のコピー。
- `codex plugin marketplace add <path> --json` → `marketplaceName: aidd-nopolicy-tmp`, `alreadyAdded: false`。
- `codex plugin add aidd-codex@aidd-nopolicy-tmp --json` → 成功。`version: 0.1.1`、`installedPath: ~/.codex/plugins/cache/aidd-nopolicy-tmp/aidd-codex/0.1.1`、`authPolicy: ON_INSTALL`。
- 結論: 公式資料が必須とする `policy` / `category` は、CLI 0.147.0 では無くても導入できる。
- 後始末: `codex plugin remove aidd-codex@aidd-nopolicy-tmp` → `codex plugin marketplace remove aidd-nopolicy-tmp`。`config.toml` に `nopolicy` を含む行なし。キャッシュに空ディレクトリが残ったので `rmdir` した。hook は信頼していないので `hooks.state` に行は増えていない。

## 2. 版を変えた入れ替え

更新前: `codex plugin list --marketplace aidd-plugins --json` は 0.1.1、キャッシュは `~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.1/` のみ。

`codex plugin marketplace upgrade aidd-plugins --json`:

```json
{ "selectedMarketplaces": ["aidd-plugins"], "upgradedRoots": ["/Users/masanori/.codex/.tmp/marketplaces/aidd-plugins"], "errors": [] }
```

直後（`add` も `remove` もしていない）:

- `codex plugin list --marketplace aidd-plugins --json` → `version: 0.1.2`, `installed: true`, `enabled: true`, `marketplaceSource.sourceType: git`
- スナップショット `~/.codex/.tmp/marketplaces/aidd-plugins/plugins/aidd-codex/.codex-plugin/plugin.json` → `version: 0.1.2`
- キャッシュは `0.1.2/` だけ。`0.1.1/` は消えた
- `diff -r ~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.2 ~/aidd-plugins/plugins/aidd-codex` → 差分なし

結論: `marketplace upgrade` はスナップショットの更新にとどまらず、導入済みプラグインをそのスナップショットから入れ直す。remove / add は要らない。「remove 無しの `add` で入れ替わるか」は、`upgrade` で足りるので測る意味が無くなった。

## 3. 信頼の維持と発火

`config.toml` の `hooks.state."aidd-codex@aidd-plugins:hooks/hooks.json:…"` 4 件の `trusted_hash` を更新前に控え、更新後と比較した。

| 鍵 | 更新前 | 更新後 |
| --- | --- | --- |
| `pre_tool_use:0:0` | `sha256:2d8932fc…a0a806` | 同一 |
| `session_start:0:0` | `sha256:f6f88f94…f3882f` | 同一 |
| `session_start:0:1` | `sha256:50bd033e…699ab0` | 同一 |
| `session_start:0:2` | `sha256:28c5c4a6…fb2c61cf` | 同一 |

`[plugins."aidd-codex@aidd-plugins"]` の `enabled = true` も維持。

発火: 検証用 clone `/Users/masanori/雑談/aidd-codex-verify`（`verify/merged-head`、クリーン）で
`codex exec -C <clone> -m gpt-5.5 -s read-only --json "…「ok」とだけ返答…"` を新規起動した。応答は `ok`。
保存セッション `01a0e591-aff9-7ee0-9b60-310e3448180f` の記録に次の 2 本の SessionStart 出力が developer message として入った。

- (c) `check-branch-pr-status.sh`: 「…マージ済みです。このまま新しい issue・機能の作業を続けると…」
- (d) `check-local-main-freshness.sh`: 「ローカル main が古い可能性があります（前回 fetch から約 26 時間経過（既定 24 時間）…）」

`check-branch-tool-ownership.sh codex` は `verify/*` ブランチなので警告しない（設計どおり出ていない）。`/hooks` の画面は開いていないが、信頼されていない hook は Codex が実行しないため、発火が信頼維持の証拠になる。

結論: `hooks.json` が不変なら、版が変わっても再信頼は不要。

## 未検証と残した状態

- `hooks.json` を変えた版での「changed - review required」の表示と、信頼するまで発火しないこと（hook 定義を変える版が出たときに測る）。
- Codex CLI 0.158 系、ChatGPT desktop app（この環境の CLI は 0.147.0 のまま）。
- 戻す方向（marketplace を前の commit に戻して `upgrade`）。
- 個人環境には `aidd-plugins` marketplace と信頼済みの `aidd-codex` 0.1.2 を残した。解除は `codex plugin remove aidd-codex@aidd-plugins` → `codex plugin marketplace remove aidd-plugins`。
