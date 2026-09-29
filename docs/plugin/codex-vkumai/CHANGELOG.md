# AIDD Codex vkumai: 変更履歴

## 0.1.5（2026-09-30）

**hook が 1 本増える版。更新の後、`/hooks` で新しい 1 本を信頼する操作が要る。**

- SessionStart に `codex-session-start.sh`（入口）を足した。セッションの始まりに、リポジトリの状態を見る点検 12 本を
  順に動かし、知らせを 1 つにまとめる（仕様書 `docs/specs/codex-hook-parity/07-claude-only-hooks.md` と
  `08-distribute-session-start-entry.md`）。点検は Claude Code 側で動いているものと同じ正本。
  - 期限の点検 4 本（守りの訓練・公式ドキュメントの差分確認・依存の棚卸し・鍵と権限の棚卸し）
  - 計測の鮮度の点検 4 本（統合テスト・E2E・認可ポリシーの変異計測・製品コードの変異計測）
  - git の hook が動いているか／中身が空のセッション記録／hook が要る実行系／長く止まったままの課題
- **知らせは人の画面には出ない。** モデルへの追加の情報として入る（Codex CLI 0.147.0 で実測）。
- 点検が見るのは、Codex が渡す作業場所（git の最上位）。プラグインの置き場所は見ない。
- 起動できない・異常終了した・合計 5 秒の上限で動かせなかった点検は、名前を挙げて知らせる。
- 12 本のうち `check-hooks-path-alive.sh` は、知らせるだけでなく**導入先の git の設定を直す**
  （`core.hooksPath` が実在しない場所を指しているとき。直す先の `scripts/git-hooks` が導入先に無ければ、何も変えない）。
- 点検が使う部品（`scripts/lib/` の 6 個と、点検の一覧）を同梱した。
- `check-blocked-issues-staleness.sh` の知らせから、中心リポジトリの文書への案内（`docs/agents/decisions.md`）を外した。
- hook 定義（`hooks/hooks.json`）が変わる。**0.1.4 までの 4 本は、位置も内容も変えていない**
  （SessionStart は 0.1.4 までこのプラグインに無かったイベントなので、入口はその 1 本目になる）。
- 必要な実行系に `python3` と `node` が加わる（無い点検は黙るか、無いことを知らせる）。`gh` があれば、長く止まった課題も見る。

## 0.1.4（2026-09-29）

初めて**スクリプトの中身が変わる**版。導入済み環境は `codex plugin marketplace upgrade aidd-plugins` で
入れ替える。

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
- `check-direct-ddl-execution.sh` が、`psql --version` / `-V` / `--help` / `-?` だけのときは止めないようにした。
  **守りを緩める変更**（仕様書 `docs/specs/codex-hook-parity/03-readonly-false-deny.md`）。
  これまで実機確認に使っていた `psql --version` は止まらなくなるので、確認には `psql -c "select 1"` などを使う。
- 依存変更を止めたときの理由文 2 つから、中心リポジトリの文書への案内（`docs/agents/…`）を外した
  （仕様書 `docs/specs/codex-hook-parity/06-message-pointers.md`）。
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
