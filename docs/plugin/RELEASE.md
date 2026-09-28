# 版を上げて配り直す手順（草案・2026-09-28）

対象: `aidd-core` / `aidd-vkumai`（Claude Code）と `aidd-codex`（Codex）。
現在はいずれも 0.1.2。ここに書くのは、次の版へ上げたときに導入済みの他リポジトリへ届けるための手順。

**状態の印**: ✅ 実測済み / 📄 公式資料で確認 / ⬜ 未検証（実測してから本文に昇格する）

## 0. 生成器に足したもの（2026-09-28 対応済み）

| 欠けていたもの | 影響 | 対応 |
| --- | --- | --- |
| marketplace リポジトリ `huuriekaiseki-sketch/aidd-plugins` に `aidd-codex` が無い | Codex 側は他リポジトリから導入できない | `--marketplace` の README と中身の一覧に `aidd-codex` を含めた（実体のコピーは以前から `outputPluginNames` で行われていた） |
| Codex 用カタログ `.agents/plugins/marketplace.json` を生成していない | 同上 | 生成器が §3.2 の形で出す ✅（`claude plugin validate` は Claude 用カタログのみ見る。Codex 側の `add` は次の配布時に実測 ⬜） |
| 版番号が `plugin-layout.json` の 3 箇所に散っている | 上げ忘れが出る | 3 箇所と依存範囲が揃っていなければ生成が失敗する ✅（`build-plugin.test.sh` scenario 8 で RED 方向を実測） |
| Claude 用カタログのエントリと `plugin.json` の両方に `version` | 公式は「両方に書くな」📄 | エントリ側を消した。正本は `plugin.json` ✅（`validate` 通過） |

**2026-09-28 に 0.1.1 で §2〜§3 を初めて回した。** marketplace リポジトリ be18c7d（タグ `aidd-core--v0.1.1` / `aidd-vkumai--v0.1.1` / `aidd-codex--v0.1.1`）。`aidd-codex` と Codex 用カタログはここで初めて載った。`claude plugin tag` は `.claude-plugin/plugin.json` を要求するので、`aidd-codex` のタグは `git tag -a` で同じ規約の名前を付けた。

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

`{name}--v{version}` のタグを 3 プラグイン分。`aidd-codex` は Claude 用 manifest が無く `claude plugin tag` が拒否するので ✅ `git tag -a aidd-codex--v<version> -m "aidd-codex <version>"` → `git push origin <tag>` で同じ名前を付ける。`aidd-vkumai` の依存解決はこのタグを見る ✅（2026-09-05 に `resolvedVersion: 0.1.0` で実測）。`aidd-codex` のタグは Codex が読むわけではないが、版と commit の対応を残すために同じ規約で付ける。

## 4. 導入先で新版を取り込む

### 4.1 Claude Code 側 📄

```bash
claude plugin update aidd-core@aidd-plugins
```

```bash
claude plugin update aidd-vkumai@aidd-plugins
```

- **依存側（aidd-core）は aidd-vkumai の update では上がらない** ✅（0.1.1 で実測。依存範囲 `^0.1.0` を旧版が満たすため）。2 本とも明示的に回す。`--scope project` で入れている導入先は同じ scope を付ける。
- 導入先が受け取るのは **版の文字列が変わったときだけ**。版を上げずに push しても届かない。
- 自動更新は marketplace ごとに利用者が `/plugin` → Marketplaces → Enable auto-update で入れる。既定はオフ。
- 再起動が要る（`update` の出力に明記）。
- hook の再承認: Claude Code 側には Codex のような hook 単位の信頼が無い。プラグインの hook は導入時点で有効になる。

### 4.2 Codex 側

```bash
codex plugin marketplace upgrade aidd-plugins
```

**これだけで新版に入れ替わる** ✅（2026-09-28、0.1.1 → 0.1.2 で実測。CLI 0.147.0）。`upgrade` は Git スナップショットを更新し、導入済みのプラグインをそのスナップショットから入れ直す。`--help` の説明「Refresh configured Git marketplace snapshots」より一段多く動く。remove も add も要らない。

- 実測: `codex plugin marketplace upgrade aidd-plugins --json` → `upgradedRoots` 1 件、`errors: []`。直後の `codex plugin list --marketplace aidd-plugins --json` は `version: 0.1.2`、キャッシュは `~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.2/` だけになり、`0.1.1/` は消えた（版別ディレクトリは並ばない）。キャッシュの中身は配布物と `diff -r` で同一。
- `codex plugin update` は存在しない ✅（CLI 0.147.0 の副コマンドは add / list / marketplace / remove）。
- remove → add の入れ直しは、`upgrade` で入れ替わらなかったときの手段として残す。同じ版の `add` 再実行は成功して版が変わらない ✅（0.1.1 で実測）。
- ChatGPT desktop app 側の更新導線は未確認 ⬜。

### 4.3 Codex の hook 再信頼

信頼は `config.toml` の `hooks.state."aidd-codex@<marketplace名>:hooks/hooks.json:<event>:<i>:<j>"` に `trusted_hash` として残る ✅。鍵と hash から分かること:

| 変えたもの | 再信頼 | 根拠 |
| --- | --- | --- |
| スクリプト本体だけ（`scripts/*.sh`） | 不要 | 同じ `hooks.json` を別パスに置いた 5 回の検証で hash が全て一致 ✅（hash は hook 定義の内容から計算され、スクリプトの中身は含まない） |
| `hooks/hooks.json` の command / timeout / matcher | **必要**。`/hooks` に「changed - review required」で出る | 公式「new or changed hooks are marked for review and skipped until trusted」📄 |
| 版番号だけ | 不要 | 0.1.1 → 0.1.2（`hooks.json` 不変）を `marketplace upgrade` で入れ替えた前後で `trusted_hash` 4 件と `enabled = true` が完全一致 ✅。更新後の新規セッションで SessionStart の hook 2 本（マージ済み PR・古い FETCH_HEAD）が再信頼なしに発火 ✅（2026-09-28） |
| marketplace の名前 | **必要**（鍵が変わり別 hook 扱い） | 鍵の形 ✅。検証用の `aidd-codex-configured` から本番の `aidd-plugins` へ移すときに 1 回起きる |

再信頼が要る版は CHANGELOG に「hook 定義変更・`/hooks` で再信頼が必要」と書き、導入先の作業に含める。

## 5. 確認（版を出したあと）

| 確認 | やり方 | 状態 |
| --- | --- | --- |
| Claude: 新版が導入先に届く | 導入先で `claude plugin update` → `claude plugin list` の版が上がる | ✅ 2026-09-28、0.1.1 で実測。`claude plugin update aidd-vkumai@aidd-plugins --scope project` → `0.1.0 → 0.1.1`、`claude plugin list` も 0.1.1。キャッシュは `~/.claude/plugins/cache/aidd-plugins/aidd-vkumai/0.1.1/` に版別で入る |
| Claude: 依存解決 | `aidd-vkumai` の update で `aidd-core` も新版になる | ❌ **上がらない**（2026-09-28 実測）。`aidd-vkumai` を 0.1.1 にしても `aidd-core` は `0.1.0-256fd54e95c6` のまま。`^0.1.0` は 0.1.0 を満たすので更新の動機が無い。**依存側も `claude plugin update aidd-core@aidd-plugins` を明示的に回す**（README の手順に含める） |
| Codex: 新版が導入先に届く | Git marketplace から add → `codex plugin list --json` の版 | ✅ 2026-09-28、`codex plugin marketplace add huuriekaiseki-sketch/aidd-plugins` → `codex plugin add aidd-codex@aidd-plugins` で 0.1.1 を導入。`marketplaceSource.sourceType` は `git`、インストール先は `~/.codex/plugins/cache/aidd-plugins/aidd-codex/0.1.1`。Git snapshot の `source.path: ./plugins/aidd-codex` は解決された。旧版からの更新は未実測 |
| Codex: 信頼状態 | `/hooks` で 4 本の状態を確認 | ✅ 新しい marketplace 名では4本とも信頼待ち。AIDD の4本だけ信頼後、同じ0.1.1を remove → add しても `trusted_hash` 4件が一致し、`/hooks` で Trusted/Active。別プラグインの信頼待ち2本は操作していない。**版を上げた状態での維持は未実測** |
| Codex: 発火 | 検証用リポジトリ `aidd-codex-verify` で (a)〜(d) のうち最低 1 つ | ✅ (c) を実測。CLI 0.147.0、`verify/merged-head` の新規 `codex exec -m gpt-5.5` セッションで、保存記録の developer message にマージ済み PR #1 の警告が入った。doctor は4本を「含まれる」、gh 認証を「有効」と表示 |
| Claude: **版を変えた**更新（0.1.1 → 0.1.2） | 2 本とも `claude plugin update` | ✅ 2026-09-28、Claude Code 2.1.270。`aidd-core` `0.1.1 → 0.1.2`、`aidd-vkumai` `0.1.1 → 0.1.2`。順に 2 本回した |
| Codex: **版を変えた**更新（0.1.1 → 0.1.2） | `codex plugin marketplace upgrade` だけで入れ替わるか | ✅ 入れ替わった（§4.2）。remove / add 不要 |
| Codex: 版を変えたあとの信頼 | `config.toml` の `trusted_hash` 4 件が更新前と一致し、新規セッションで発火する | ✅ 4 件とも一致・`enabled = true` 維持。`verify/merged-head` の新規 `codex exec` セッション `01a0e591-…` の保存記録に (c) マージ済み PR の警告と (d) 「前回 fetch から約 26 時間経過」の警告が入った。`/hooks` の画面は見ていないが、信頼されていない hook は実行されないので発火が信頼の証拠になる |
| Codex: `policy` / `category` 無しのカタログ | 一時 marketplace（local path）から `add` | ✅ 通った（2026-09-28）。エントリが name / description / source だけの `.agents/plugins/marketplace.json` を `codex plugin marketplace add <path>` → `codex plugin add aidd-codex@aidd-nopolicy-tmp` で 0.1.1 が入った。公式の「必須」は CLI 0.147.0 では強制されない。検証後に plugin と marketplace を remove し、`config.toml` に残骸なし |

検証用リポジトリと clone（`/Users/masanori/雑談/aidd-codex-verify`）はこの目的で残してある。

Codex 側の実測は CLI 0.147.0 と marketplace commit `be18c7d` で行った。CLI の既定モデル `gpt-6-sol` はこの ChatGPT アカウントで非対応だったため、発火確認には `gpt-5.5` を指定した。[実証記録](codex/evidence/2026-09-28-marketplace-verify.md)に導入・信頼・発火の証拠と未検証範囲を残した。検証用 clone はクリーン。個人環境には `aidd-plugins` marketplace と信頼済み `aidd-codex`（0.1.2 に更新済み）を残している（解除は `codex plugin remove aidd-codex@aidd-plugins` → `codex plugin marketplace remove aidd-plugins`。信頼記録は自動で消えるとは限らない）。

配布後にこの表へ書き戻した結果は、中心リポジトリの `dist/plugins` には入るが marketplace 上の同じ版には
届かない（版の文字列が同じなので配り直さない。タグの内容も動かさない）。次の版で届く。

## 6. 戻し方

- Claude: marketplace リポジトリを前の commit に戻して push。導入先は `claude plugin update` で戻る（版の文字列が変われば届く）。ピン留めするならカタログのエントリに `ref` / `sha` 📄。
- Codex: marketplace を戻して `codex plugin marketplace upgrade aidd-plugins`。`upgrade` がスナップショットから入れ直すので remove / add は要らない（0.1.2 で実測した挙動の裏返し。戻す方向は未実測 ⬜）。
- タグは消さない（依存解決の履歴になる）。

## 7. 未検証の一覧（実測してから本文へ）

1. Git 経由の `local` + 相対パスは 0.1.1 で解決済み ✅。別の Git ホストや `git-subdir` 形式は未検証。
2. `policy` / `category` は有っても無くても `add` が通る ✅（0.1.2 で無しを実測）。
3. 版を変えた入れ替えは `codex plugin marketplace upgrade` だけで起きる ✅（0.1.1 → 0.1.2）。remove 無しの `add` が要るかは、`upgrade` で足りるので測る意味が無くなった。
4. 版を上げたあとも `trusted_hash` は維持され、hook は再信頼なしに発火する ✅（0.1.1 → 0.1.2、hooks.json 不変）。
5. Codex CLI 0.158 系（desktop 同梱）で `.codex-plugin` 形式が引き続き認識されるか。0.147.0 でしか実測していない ⬜。この環境の CLI は 0.147.0 のままなので、CLI を上げたときに測る。
6. ChatGPT desktop app での更新導線 ⬜。
7. `hooks.json` を**変えた**版で `/hooks` に「changed - review required」が出て、信頼するまで発火しないこと ⬜（公式資料の記述のみ。実測には hook 定義を変える版が要る）。

Codex 側の 0.1.2 の記録は [実証記録](codex/evidence/2026-09-28-version-update-verify.md)。

根拠: [Claude Code: Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)、[OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)、[OpenAI: Hooks](https://learn.chatgpt.com/docs/hooks)、`docs/plugin/codex/evidence/2026-09-27-verify.md`、`~/.codex/config.toml` の `hooks.state`（2026-09-28 時点）。
