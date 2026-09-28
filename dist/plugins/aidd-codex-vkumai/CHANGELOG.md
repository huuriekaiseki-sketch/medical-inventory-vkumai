# AIDD Codex vkumai: 変更履歴

## 0.1.3（2026-09-28）

- marketplace `aidd-plugins` に初めて載る版。導入は `codex plugin add aidd-codex-vkumai@aidd-plugins` → `/hooks` で 4 本を信頼。
- 中身は 0.1.2（新設時）と同じ。

## 0.1.2（2026-09-28）

- 新設。vkumai の `.codex/hooks.json` のうち、製品固有の判定を含むため `aidd-codex` 初版から外していた 4 本
  （仕様書 `docs/superpowers/specs/2026-09-26-aidd-codex-plugin-design.md` §3 の「入れない」）を配る。
  - PreToolUse `check-direct-ddl-execution.sh`: Supabase の直接 DDL（`supabase db execute` / `psql`）、
    `--local` 無しの `supabase db push`、`npx supabase` を deny
  - PreToolUse `codex-dependency-change-deny.sh`: npm / yarn / pnpm の依存変更と package.json 系への書き込みを deny
    （判定本体 `check-dependency-change.sh` は Claude 側 `aidd-vkumai` と同じ正本からの複製。Claude 側の ask を Codex では deny に読み替える）
  - PostToolUse `codex-ai-check-track.sh` と Stop `codex-ai-check-suggest.sh`: `.ts` / `.tsx` / `.sql` を変えたのに
    `npm run ai:check` 系（typecheck / lint / test / 統合 / E2E）を打っていなければセッション終了時に警告
- 版は `aidd-codex` と同じ値で揃える（中心リポジトリの生成器が揃っていなければ生成しない）。
- 中心リポジトリ vkumai 自身では project hook（`.codex/hooks.json`）を正とし、このプラグインは入れない（二重発火するため）。
