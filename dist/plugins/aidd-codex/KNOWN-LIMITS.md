# AIDD Codex: 既知の制約

- この配布物の hook は、Codex で利用者が信頼するまで実行されない。信頼状態を読み取る公開インターフェースを確認できないため、doctor は「不明」と報告する。「実行前提あり」は信頼済み・発火済み・保護済みを意味しない。導入手順では Codex の `/hooks` で対象 hook を確認・信頼することを必須ステップとし、その後に実発火を別途確認する。
- 生成物は `.codex-plugin/plugin.json` のトップレベル `hooks` を持つ形式で、ルート `plugin.json` は出さない。公式推奨の portable 形式（ルート `plugin.json` と `extensions.com.openai.hooks`）は Codex CLI 0.147.0 で hook が認識されなかった。CLI 更新後に portable 形式へ戻すかは別途判断する。根拠は中心リポジトリの `docs/plugin/codex/evidence/2026-09-27-verify.md` の一変数実験 C'。
- `codex-skip-marker-deny.sh` が守るのは Claude 側の verify-claims が使う `.claude/.verify-state/*.skip` への書き込みだけ。導入先が Claude 側の verify-claims を使わなければ、実質的に何も守らない。`jq` が無い場合は exit 2 で失敗する。
- `check-branch-pr-status.sh` は GitHub remote、`gh` と認証、対象ブランチのマージ済み PR がなければ警告を出さない。`jq` が無い場合も静かに終了する。
- `check-branch-tool-ownership.sh codex` は `claude/*` ブランチでのみ警告する。別の名前のブランチでは警告しない。`jq` または Git の情報が無ければ判定できない。
- `check-local-main-freshness.sh` は `origin/main` と `FETCH_HEAD` がある導入先で鮮度を近似する。`FETCH_HEAD` が無い場合は古い可能性を警告する。`origin/main` が無い場合は behind 数を測れず、`python3` が無い場合は fetch 時刻を測れない。実際のリモート最新状態はネットワーク照会しない。
- project の `.codex/hooks.json` に同じ hook があると二重発火しうる。doctor は警告のみで設定を書き換えない。
- doctor は実行記録を持たず、実発火の有無や効果を報告しない。
- vkumai 固有の hook（Supabase 直接 DDL の deny・npm 依存変更の deny・品質チェック未実行の警告）はこのプラグインに入っていない。別プラグイン `aidd-codex-vkumai`（Next.js + Supabase + npm 前提）で配る。doctor はそちらの hook を診断しない。

根拠: [OpenAI 公式のプラグイン構成と hook 信頼の説明](https://developers.openai.com/plugins/build/plugins)。
