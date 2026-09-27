# 版を上げて配り直す手順（草案・2026-09-28）

対象: `aidd-core` / `aidd-vkumai`（Claude Code）と `aidd-codex`（Codex）。
現在はいずれも 0.1.0。ここに書くのは「1.1 や 1.2 に上げたとき、導入済みの他リポジトリへ届ける」ための手順。

**状態の印**: ✅ 実測済み / 📄 公式資料で確認 / ⬜ 未検証（実測してから本文に昇格する）

## 0. 生成器に足したもの（2026-09-28 対応済み）

| 欠けていたもの | 影響 | 対応 |
| --- | --- | --- |
| marketplace リポジトリ `huuriekaiseki-sketch/aidd-plugins` に `aidd-codex` が無い | Codex 側は他リポジトリから導入できない | `--marketplace` の README と中身の一覧に `aidd-codex` を含めた（実体のコピーは以前から `outputPluginNames` で行われていた） |
| Codex 用カタログ `.agents/plugins/marketplace.json` を生成していない | 同上 | 生成器が §3.2 の形で出す ✅（`claude plugin validate` は Claude 用カタログのみ見る。Codex 側の `add` は次の配布時に実測 ⬜） |
| 版番号が `plugin-layout.json` の 3 箇所に散っている | 上げ忘れが出る | 3 箇所と依存範囲が揃っていなければ生成が失敗する ✅（`build-plugin.test.sh` scenario 8 で RED 方向を実測） |
| Claude 用カタログのエントリと `plugin.json` の両方に `version` | 公式は「両方に書くな」📄 | エントリ側を消した。正本は `plugin.json` ✅（`validate` 通過） |

**marketplace リポジトリ側はまだ 0.1.0 の生成物のまま。** 次に §3 を回したときに `aidd-codex` とカタログが初めて載る。

## 1. 版番号の決め方

- semver。`BREAKING.md` の「破壊的」に当たる変更（設定キー・hook の入出力契約・ログ列・名前・層の移動）は **メジャーを上げる**。それ以外の機能追加はマイナー、直しだけならパッチ。
- 3 プラグインは**同じ版を同時に上げる**（独立に上げると `aidd-vkumai` の依存範囲 `^0.1.0` が `aidd-core` の新版と合わなくなり、導入先の依存解決が失敗する 📄）。`aidd-vkumai.dependencies[].version` の範囲も同時に更新する。
- Codex 側の版は `codexPlugin.version`。Claude 側と同じ値にする（別々に管理する理由が無い）。

## 2. 中心リポジトリ（vkumai）での作業

1. `scripts/lib/plugin-layout.json` の版を 3 箇所上げる: `plugins.aidd-core.version` / `plugins.aidd-vkumai.version`（＋ `dependencies[].version`）/ `codexPlugin.version`。
2. `docs/plugin/CHANGELOG.md` と `docs/plugin/codex/CHANGELOG.md` に版の節を足す。破壊的変更があれば `BREAKING.md` の表に行と移行手順を足す。
3. `docs/plugin/COMPATIBILITY.md` と `docs/plugin/codex/COMPATIBILITY.md` の「最後に確認した版」を、実際に実走した Claude Code / Codex CLI の版に更新する。
4. 生成と検査:
   ```bash
   bash scripts/build-plugin.sh
   ```
   ```bash
   bash scripts/build-plugin.sh --check
   ```
   ```bash
   bash scripts/build-plugin.test.sh
   ```
5. `dist/plugins/aidd-codex/hooks/hooks.json` の差分を見る。**ここが変わると導入先は再信頼が要る**（§4.3）。変わっていなければ CHANGELOG に「hook 定義は不変・再信頼不要」と書く。
6. PR を作り、必須 CI が success になってからマージする。

## 3. marketplace リポジトリへ配る

### 3.1 生成して push

```bash
bash scripts/build-plugin.sh --marketplace --out ~/aidd-plugins/plugins
```

`~/aidd-plugins` は `huuriekaiseki-sketch/aidd-plugins` の clone。生成後に `claude plugin validate ~/aidd-plugins` を通してからコミット・push する（前回 2026-09-06 は手作業で push した ✅）。

### 3.2 Codex 用カタログ（生成器に足す内容）

marketplace ルートに `.agents/plugins/marketplace.json` を置く 📄。1 つのリポジトリに Claude 用と Codex 用の 2 つのカタログが同居する形。

```json
{
  "name": "aidd-plugins",
  "plugins": [
    {
      "name": "aidd-codex",
      "source": { "source": "local", "path": "./plugins/aidd-codex" },
      "policy": { "installation": "AVAILABLE" },
      "category": "Developer tools"
    }
  ]
}
```

- 生成器はこの形を出す（`scripts/lib/build-plugin.mjs`、`--marketplace` 時）。
- `source: local` + `path` は実測済みの形 ✅（検証では絶対パスだった。Git で配るときはリポジトリ内相対パスにする。相対パスでの解決は未実測 ⬜）。
- `policy` / `category` は公式の必須項目 📄。検証時に付けていたかは未確認 ⬜。無くて動くか、あって壊れるかを実測する。
- Git 越しに取るときの別形 `git-subdir`（`url` + `path` + `ref`/`sha`）📄 は未実測 ⬜。

### 3.3 タグ

```bash
claude plugin tag ~/aidd-plugins/plugins/aidd-core --push
```

`{name}--v{version}` のタグを 3 プラグイン分。`aidd-vkumai` の依存解決はこのタグを見る ✅（2026-09-05 に `resolvedVersion: 0.1.0` で実測）。`aidd-codex` のタグは Codex が読むわけではないが、版と commit の対応を残すために同じ規約で付ける。

## 4. 導入先で新版を取り込む

### 4.1 Claude Code 側 📄

```bash
claude plugin update aidd-vkumai@aidd-plugins
```

- 導入先が受け取るのは **版の文字列が変わったときだけ**。版を上げずに push しても届かない。
- 自動更新は marketplace ごとに利用者が `/plugin` → Marketplaces → Enable auto-update で入れる。既定はオフ。
- 再起動が要る（`update` の出力に明記）。
- hook の再承認: Claude Code 側には Codex のような hook 単位の信頼が無い。プラグインの hook は導入時点で有効になる。

### 4.2 Codex 側

```bash
codex plugin marketplace upgrade aidd-plugins
```

これは Git marketplace のスナップショットを更新するだけ ✅（`--help` で確認）。その後にプラグイン本体を入れ直す:

```bash
codex plugin remove aidd-codex@aidd-plugins
```

```bash
codex plugin add aidd-codex@aidd-plugins
```

- `codex plugin update` は存在しない ✅（CLI 0.147.0 の副コマンドは add / list / marketplace / remove）。
- **remove せずに `add` し直すだけで新版に入れ替わるか**は未実測 ⬜。キャッシュのパスに版が入る（`~/.codex/plugins/cache/<marketplace>/aidd-codex/<version>/` ✅）ので、新版は別ディレクトリに入るはず。実測して確定する。
- ChatGPT desktop app 側の更新導線は未確認 ⬜。

### 4.3 Codex の hook 再信頼

信頼は `config.toml` の `hooks.state."aidd-codex@<marketplace名>:hooks/hooks.json:<event>:<i>:<j>"` に `trusted_hash` として残る ✅。鍵と hash から分かること:

| 変えたもの | 再信頼 | 根拠 |
| --- | --- | --- |
| スクリプト本体だけ（`scripts/*.sh`） | 不要 | 同じ `hooks.json` を別パスに置いた 5 回の検証で hash が全て一致 ✅（hash は hook 定義の内容から計算され、スクリプトの中身は含まない） |
| `hooks/hooks.json` の command / timeout / matcher | **必要**。`/hooks` に「changed - review required」で出る | 公式「new or changed hooks are marked for review and skipped until trusted」📄 |
| 版番号だけ | 不要 | 鍵に版が入っていない ✅ |
| marketplace の名前 | **必要**（鍵が変わり別 hook 扱い） | 鍵の形 ✅。検証用の `aidd-codex-configured` から本番の `aidd-plugins` へ移すときに 1 回起きる |

再信頼が要る版は CHANGELOG に「hook 定義変更・`/hooks` で再信頼が必要」と書き、導入先の作業に含める。

## 5. 確認（版を出したあと）

| 確認 | やり方 | 状態 |
| --- | --- | --- |
| Claude: 新版が導入先に届く | 導入先で `claude plugin update` → `claude plugin list` の版が上がる | ⬜ |
| Claude: 依存解決 | `aidd-vkumai` の update で `aidd-core` も新版になる | ⬜ |
| Codex: 新版が導入先に届く | remove → add → `codex plugin list --json` の版 | ⬜ |
| Codex: 信頼状態 | `/hooks` で 4 本が Trusted のまま（hooks.json 不変のとき） | ⬜（不変時に Trusted 維持は段階 (5) で 1 回実測 ✅。版を上げた状態では未実測） |
| Codex: 発火 | 検証用リポジトリ `aidd-codex-verify` で (a)〜(d) のうち最低 1 つ | ⬜ |

検証用リポジトリと clone（`/Users/masanori/雑談/aidd-codex-verify`）はこの目的で残してある。

## 6. 戻し方

- Claude: marketplace リポジトリを前の commit に戻して push。導入先は `claude plugin update` で戻る（版の文字列が変われば届く）。ピン留めするならカタログのエントリに `ref` / `sha` 📄。
- Codex: `codex plugin add` はスナップショット時点のものを入れるので、marketplace を戻して `upgrade` → remove → add。
- タグは消さない（依存解決の履歴になる）。

## 7. 未検証の一覧（実測してから本文へ）

1. Codex の `.agents/plugins/marketplace.json` を Git 経由で `codex plugin marketplace add owner/repo` したときに `local` + 相対パスが解決されるか。
2. `policy` / `category` の有無で `add` が通るか。
3. remove 無しの `add` で版が入れ替わるか。
4. 版を上げたあとも `trusted_hash` が維持されるか（hooks.json 不変のとき）。
5. Codex CLI 0.158 系（desktop 同梱）で `.codex-plugin` 形式が引き続き認識されるか。0.147.0 でしか実測していない。
6. ChatGPT desktop app での更新導線。

根拠: [Claude Code: Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)、[OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)、[OpenAI: Hooks](https://learn.chatgpt.com/docs/hooks)、`docs/plugin/codex/evidence/2026-09-27-verify.md`、`~/.codex/config.toml` の `hooks.state`（2026-09-28 時点）。
