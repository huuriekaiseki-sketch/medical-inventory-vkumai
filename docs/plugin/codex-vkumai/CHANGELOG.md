# AIDD Codex vkumai: 変更履歴

## 未リリース（次の版で配る）

- `check-dependency-change.sh` が Codex のファイル編集（`apply_patch`）を読むようにした。0.1.3 までは
  ファイル編集で `package.json` / `package-lock.json` を書き換えても止まらなかった（仕様書
  `docs/specs/codex-hook-parity/01-apply-patch.md`）。
- この直しで **Codex は `package.json` を一切編集できなくなる**（`scripts` 欄だけの変更でも止まる）。
- `codex-ai-check-suggest.sh` / `codex-ai-check-track.sh` が、記録の置き場に書けなくても失敗として終わらない
  ようにした（0.1.3 までは rc=1）。Stop 側は読むだけにし、置き場の用意と古い記録の掃除は記録を書く側だけが行う
  （仕様書 `docs/specs/codex-hook-parity/05-stop-hook-never-fails.md`）。
- `codex-dependency-change-deny.sh` が、判定本体が無い・失敗した・読めない結果を返したときに exit 2 で
  止める側に倒すようにした（0.1.3 までは rc=127 などで抜けるだけ。
  仕様書 `docs/specs/codex-hook-parity/04-wrapper-fail-closed.md`）。
- `check-direct-ddl-execution.sh` / `check-dependency-change.sh` が、前置き付きのコマンドを止めるようにした
  （`PGPASSWORD=… psql`、`sudo npm install foo`、`bash -c "psql …"`、`npm --prefix web install foo` など。
  0.1.3 までは素通り。仕様書 `docs/specs/codex-hook-parity/02-command-prefix.md`）。**止まる範囲が広がる。**
- hook 定義（`hooks/hooks.json`）は不変。**再信頼不要**。
- Codex CLI 0.147.0 の実機で deny を実測した（`docs/plugin/codex/evidence/2026-09-29-apply-patch-verify.md`。
  0.1.3 のキャッシュの判定本体を一時的に差し替えて測った。配布した版そのものでの発火は、配ってから測る）。

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
