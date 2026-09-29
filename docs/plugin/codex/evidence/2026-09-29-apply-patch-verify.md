# Codex のファイル編集（apply_patch）での deny: 実機確認

実施日: 2026-09-29。中心リポジトリ `70802014`（PR #858）、Codex CLI 0.147.0（モデル `gpt-5.5`）。検証用 clone は `/Users/masanori/雑談/aidd-codex-verify` の `verify/merged-head`。開始時の `git status --short` は空。個人環境の一時変更と `codex exec` の実行は事前承認を得て実施した。`--dangerously-bypass-hook-trust` は使っていない。

仕様書: `docs/specs/codex-hook-parity/01-apply-patch.md`。

## 何を測ったか

0.1.3 の判定本体は Claude の形（`Write` / `Edit` + `tool_input.file_path`）しか知らず、Codex のファイル編集を素通りさせていた。直した判定本体が、**Codex の実機で** `apply_patch` を止めるかを測った。

## 測り方

導入済みプラグインは 0.1.3 のまま（直した版はまだ配っていない）。信頼の hash は hook 定義から計算され、スクリプトの中身を含まない（`docs/plugin/RELEASE.md` §4.3）ので、**キャッシュ内の判定本体 2 本だけを一時的に差し替えた**。`hooks.json`・ラッパー・`config.toml` は触っていない。

| 差し替えたファイル | 差し替え前後の sha256 |
| --- | --- |
| `~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.3/scripts/check-skip-marker-write.sh` | `9dfb1f31…9234213`（main の配布物と一致）→ 測定 → 同じ値に復元 |
| `~/.codex/plugins/cache/aidd-plugins/aidd-codex-vkumai/0.1.3/scripts/check-dependency-change.sh` | `ac2884b6…85049dd9`（同上）→ 測定 → 同じ値に復元 |

差し替えた版は、PR #858 の配布物に「受け取った入力を 1 行ずつ残す」計測行を 1 行足したもの。計測行は測定用のコピーだけにあり、正本にも配布物にも無い。

## 結果

| 操作（`codex exec -m gpt-5.5 --json -s workspace-write`、各 1 回） | 観測 |
| --- | --- |
| `apply_patch` だけで `.claude/.verify-state/x.skip` を新規作成させる | セッション `01a0ebb0-1a75-74c3-8650-247ad02bf0ef`。`Command blocked by PreToolUse hook: （Codexはask未対応のためdenyに読み替え）verify-claimsのエスケープハッチ(.skipマーカー)への書き込みです。…` がツール呼び出しのエラーとして出た。ファイルは作られていない。再試行なし |
| `apply_patch` だけでリポジトリ直下に `package.json` を新規作成させる | セッション `01a0ebb0-672d-7fb1-8166-8cce54b43800`。`Command blocked by PreToolUse hook: （Codexはask未対応のためdenyに読み替え）package.json への直接編集は依存関係の変更です…` が同じ経路で出た。ファイルは作られていない。再試行なし |

deny の根拠はツール呼び出しの記録で、モデルの説明文ではない。

## hook が受け取った入力の形（実測）

```json
{
  "tool_name": "apply_patch",
  "hook_event_name": "PreToolUse",
  "cwd": "/Users/masanori/雑談/aidd-codex-verify",
  "tool_input": { "command": "*** Begin Patch\n*** Add File: package.json\n+{\"name\":\"probe\"}\n*** End Patch\n" }
}
```

- 最上位のキー: `cwd` / `hook_event_name` / `model` / `permission_mode` / `session_id` / `tool_input` / `tool_name` / `tool_use_id` / `transcript_path` / `turn_id`
- `tool_input` のキーは `command` だけ。`file_path` は無い
- `command` はパッチ本文そのもの（シェルの heredoc などで包まれていない）。パスは cwd からの相対
- [公式ドキュメント](https://learn.chatgpt.com/docs/hooks)の記述と一致した

## matcher のエイリアス

`hooks.json` の matcher は `Bash|Write|Edit|MultiEdit` のままで、`apply_patch` は書いていない。それでも 1 回の `apply_patch` に対して、`aidd-codex` と `aidd-codex-vkumai` の両方の hook が呼ばれた（入力の記録が 2 本とも残った）。**CLI 0.147.0 では `Edit` / `Write` が `apply_patch` のエイリアスとして効く。** matcher を変える必要は無く、導入済み環境の再信頼も要らない。

## 後始末

- キャッシュの 2 本を控えから復元し、sha256 が main の配布物と一致することを確認した
- 検証用 clone の `git status --short --ignored` は空（`.claude/` も `package.json` も作られていない）
- 個人環境の導入状態（`aidd-plugins` marketplace、信頼済みの `aidd-codex` / `aidd-codex-vkumai` 0.1.3）は測定前と同じ

## 測っていないこと

- **直す前の版が実機で素通りさせること**。素通りはスクリプト単体でしか測っていない（同じ入力の形で沈黙・rc=0）。実機の入力の形が上の通りなので、0.1.3 の `case` 文では `*) exit 0` に落ちる
- ヘッダ 4 種のうち、実機で測ったのは `*** Add File:` だけ。`Update File` / `Delete File` / `Move to` はスクリプト単体のテストのみ
- 複数ファイルのパッチ、cwd がリポジトリ直下でない場合
- 配布した版そのもの（次の版）での発火。今回は 0.1.3 のキャッシュを差し替えて測った
- ChatGPT desktop app、CLI 0.158 系

## 測定中に出た、対象外の表示

`codex exec` の起動時に、MCP サーバー（`127.0.0.1:3001` / `:3101`）への接続失敗と、`~/.agents/skills/` の 2 本（`aidd-status` / `chain-serial`）の読み込み失敗が出た。どちらも個人環境の設定によるもので、今回の hook とは関係しない。直していない。
