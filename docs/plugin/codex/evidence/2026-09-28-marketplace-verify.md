# Codex 用プラグイン 0.1.1: Git marketplace 導入実測

実施日: 2026-09-28。対象は Codex CLI 0.147.0、非公開の検証用リポジトリ `huuriekaiseki-sketch/aidd-codex-verify`。marketplace は `huuriekaiseki-sketch/aidd-plugins` の `be18c7d`。検証用 clone に project `.codex/hooks.json` は無い。

## 導入と信頼

1. `codex plugin marketplace add huuriekaiseki-sketch/aidd-plugins --json` は `marketplaceName: aidd-plugins` を返した。取得された Git snapshot の `.agents/plugins/marketplace.json` は `source: local`、`path: ./plugins/aidd-codex`、`policy.installation: AVAILABLE`、`category: Developer tools` を含む。
2. `codex plugin add aidd-codex@aidd-plugins --json` は `version: 0.1.1`、`installedPath: ~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.1` を返した。`codex plugin list --marketplace aidd-plugins --json` は installed / enabled と `marketplaceSource.sourceType: git` を報告した。Git snapshot のプラグイン本体とインストール後の cache は `diff -qr` で差分なし。
3. 新規 CLI の `/hooks` では AIDD 由来の PreToolUse 1本と SessionStart 3本が信頼待ちになった。4本のコマンドは cache の `scripts/` を参照していた。AIDD の4本だけを個別に信頼した。別プラグインの信頼待ち2本は触れていない。
4. 導入済みのまま `codex plugin add aidd-codex@aidd-plugins --json` を再実行すると成功し、版は 0.1.1 のまま。その後 `codex plugin remove aidd-codex@aidd-plugins` → `codex plugin add aidd-codex@aidd-plugins --json` を行った。前後で4件の `trusted_hash` は同一。新規 CLI の `/hooks` でも対象4本は Trusted/Active と表示された。これらは**同一版の再導入**の結果であり、版を変えた更新の結果ではない。

## 実発火

検証用 clone の `verify/merged-head` は [PR #1](https://github.com/huuriekaiseki-sketch/aidd-codex-verify/pull/1) のマージ済み head。信頼後に同ブランチで `codex exec -m gpt-5.5 --json -s read-only` の新規セッションを起動した。保存セッション `01a0e573-5bab-7e40-95b6-66d659ef5beb` の developer message に次の警告が入った。

> 現在のブランチ「verify/merged-head」は既に以下のPRでマージ済みです。… - #1 test: merged head fixture for Codex hooks

これは `check-branch-pr-status.sh` の出力に対応する。CLI の既定モデル `gpt-6-sol` はこの ChatGPT アカウントでは 400 エラーになったため、実発火の確認には `gpt-5.5` を使った。`aidd-codex-doctor.sh` は4本を「含まれる」、gh 認証を「有効」、二重登録を「なし」と報告した。doctor の信頼状態は設計どおり「不明」。検証用 clone は最後に `git status --short` が空だった。

## 未検証と残した状態

- `policy` / `category` のどちらかを取り除いた場合の導入可否。
- 旧版から新版への更新時、remove 無しの `add` で版が入れ替わるか、`trusted_hash` が維持されるか。marketplace に Codex 用 0.1.0 が無く、0.1.1 からの版変更は行っていない。
- Codex CLI 0.158 系、ChatGPT desktop app の更新導線、他の3本の hook の 0.1.1 での再発火。

個人環境には Git marketplace `aidd-plugins` と、信頼済みの `aidd-codex` 0.1.1 を残した。解除はプラグインを `codex plugin remove`、続いて marketplace を `codex plugin marketplace remove` する。`hooks.state` の信頼記録が残る可能性があるため、解除後は該当4件を確認する。
