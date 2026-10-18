# SPEC: 止めた回の記録（hook-decisions.jsonl）を人が読める形にする

- feature: `hook-decisions-summary`
- 重要度: 中 / 影響: 月次サマリ（Stop hook）の本文 1 段落と、新しいスクリプト 3 本。判定を出す hook には触れない
- 前提: PR #896（`docs/specs/hook-decision-log.md`）。記録の 1 行の形はそちらが正本
- 状態: 2026-10-18 承認（ユーザーの言葉「うん、いいですよ。どんどんやって。」を親セッション経由で受領。決めてほしいこと 1〜7 はすべておすすめの通り。ただし 1 は PR #896 が先にマージされたため「#896 のブランチに積む」でなく「マージ後の origin/main を取り込む」に読み替えた）。スクリプトとテストは実装済み。本物の記録は 2026-10-18 時点で 1 行（親セッションの実機確認の deny）

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

PR #896 で、止める PreToolUse hook 5 本が deny / ask / warn を出した回が
`logs/hook-decisions.jsonl` に 1 行ずつ残るようになりました。この記録を**人が読める形**で出せるようになります。

| 出口 | いつ見るか | 中身 |
| --- | --- | --- |
| `bash scripts/summarize-hook-decisions.sh [--days N] [--json]` | 手で見たいとき | hook × decision の件数、rule 別、caller 別、直近の行 |
| 月次サマリ（`gate-effectiveness-monthly-check.sh`、Stop hook） | 30 日に 1 回、自動 | 上の集計を 1 段落 |
| `bash scripts/render-hook-decisions-html.sh [--days N] [--out PATH]` | 棚卸しのとき手で | 静的 HTML 1 枚。上の集計 ＋ ハーネスの成績（部品 × 層）＋ hook 一覧 × `.test.sh` の有無 × 実走の最終記録日 |

**本物の記録はまだほぼ無い**（hook はメインのチェックアウトから読まれるので、PR #896 が main に入り
メイン側が追従するまで 1 行も書かれない）。だから、この仕組みは**件数が 0〜数件のときに嘘をつかない**ことを
最優先に設計します。SNS 映えより中身の正確さ、が方針です。

## 0 件・少数のときの見せ方（いちばん大事な決め）

記録が無いことを「hook が止めていない（良いこと）」と読ませてはいけません（C-025: 不在を合格と読まない）。
記録が無い理由は少なくとも 3 つあり、集計は**どれなのか分からないなら分からないと言う**形で出します。

| 状態 | 出す文（要旨） |
| --- | --- |
| 記録ファイルが無い | 「記録なし。hook が一度も止めていないか、記録が黙って飛んでいる（記録部品が配られていない・jq 無し・書けない）か、まだ区別できない」＋ 区別する手がかり（メインのチェックアウトに `scripts/lib/log-hook-decision.sh` があるか） |
| ファイルはあるが全期間 0 行 | 同上（空ファイル） |
| 全期間には行があるが、期間内 0 件 | 「直近 N 日は 0 件（全期間 M 件、最新 YYYY-MM-DD）」。この場合だけ「期間内に止めていない」と読んでよい、と添える |
| 期間内 1〜9 件 | **表を出さない。** 1 行ずつ「日時 / hook / decision / rule / target / caller」で並べる（数件の表は中身が薄く見えるだけで、行で読んだほうが速い） |
| 期間内 10 件以上 | 表 3 つ（hook × decision / rule 別 / caller 別）＋ 直近 10 件 |

壊れた行（JSON として読めない・`decision` が deny / ask / warn 以外）は**落とさず数えて別枠で出す**（「壊れた行 N 件」）。
黙って落とすと、記録部品のバグが「件数が少ない」に化けて見えなくなるからです。

Codex のラッパー 2 本は正本の ask を deny に読み替えて返しますが、記録上の `decision` は `ask` のまま
（PR #896 の決め）。集計は記録どおりに数え、脚注で「うち `caller: codex` の ask N 件は実際には deny に読み替えられている」と添えます。

## 集計の中身

期間の既定は 30 日（月次サマリと同じ）。`--json` では文章ではなく次の構造を出します。

```json
{"logFile":"…/logs/hook-decisions.jsonl","days":30,"since":"2026-09-18T00:00:00Z",
 "fileState":"present|missing|empty",
 "total":{"allTime":12,"inWindow":9},
 "latestTimestamp":"2026-10-18T01:23:45Z",
 "byHookDecision":{"check-direct-ddl-execution":{"deny":3,"ask":0,"warn":0}},
 "byRule":{"direct_exec":3},
 "byCaller":{"claude":7,"codex":2,"unknown":0},
 "codexAskRelabeledAsDeny":2,
 "recent":[{"timestamp":"…","hook":"…","decision":"…","rule":"…","target":"…","caller":"…"}],
 "broken":{"count":1,"lines":[7]}}
```

テキスト出力は上の「見せ方」の規則に従います。`fileState` と `total` は常に出し、読む側が
「無い」と「期間外」を取り違えないようにします。

## 静的 HTML の中身

`logs/hook-decisions.html`（git 管理外、`resolve_log_dir` と同じ場所）に 1 枚。外部読み込みなし（CDN・フォント・JS ライブラリを使わない。オフラインで開ける）。Next.js は使わず `src/` に触れません。

| 節 | 元データ | 出自の注記（HTML に必ず書く） |
| --- | --- | --- |
| 1. 止めた回 | `hook-decisions.jsonl`（上の集計と**同じ関数**） | 機械記録。allow は書かれないので発火率の分母は無い |
| 2. ハーネスの成績（部品 × 層） | `node scripts/lib/check-harness-score.mjs --summary` の TSV | **自己申告**（issue を閉じるとき人が書く）。取れなければ「取得できませんでした」と書き、空の表を出さない |
| 3. hook 一覧 | `.claude/settings.json` と `.codex/hooks.json` の登録（`aidd-doctor.mjs` の `collectHookCommands`）× `scripts/<name>.test.sh` の有無 × `docs/agents/hook-live-drill.md` に書かれた実走の最終記録日 × 期間内に止めた回数 | 実走日は**ドリル文書の見出しと行に書かれた日付からの近似**。書き忘れれば古いまま、実機で発火するかは測っていない |

節 3 で「止める力があるのに期間内 0 件」の行がそのまま見えるのが狙いです（記録の無い hook を隠さない）。

## 受け入れ条件

印の意味: ✅ スクリプト単体のテストで確認済み / 🟡 一部 / ⬜ 未実施

- ✅ fixture の jsonl（13 行。hook 5 本・decision 3 値・caller 3 値・期間外 1 行・壊れた行 2 行＝JSON 不正と語彙外 decision を含む）で、hook × decision / rule 別 / caller 別の件数が手で数えた値と一致する（テキストと `--json` の両方）
- ✅ 記録ファイルが無い／空のとき、「止めていない」と「記録が飛んでいる」の**両方**の可能性を書いた文が出て exit 0（`summarize-hook-decisions.test.sh` scenario 4・5）
- ✅ 全期間には行があるが期間内 0 件のとき、「直近 N 日は 0 件（全期間 M 件、最新 …）」が出る（同 scenario 6）
- ✅ 期間内 1〜9 件では表の見出し行が出ず、1 件 1 行で出る。10 件以上で表が出る（同 scenario 3・3b。閾値の両側）
- ✅ 壊れた行が「壊れた行 N 件」として数えられ、集計からは除かれる（RED 方向: 壊れた行を混ぜても件数が増えない・黙って消えもしない。同 scenario 7）
- ✅ 月次サマリの本文に「止めた回」の段落が入る。集計スクリプトが無い環境でも hook は落ちず、断り書きが出る（`gate-effectiveness-monthly-check.test.sh` scenario 6・7）
- ✅ HTML: fixture の設定・ドリル文書・成績ファイルで、`.test.sh` の有無が行ごとに正しく出る／実走日が複数あれば最新を取る（散文の日付は拾わない）／成績コマンドが失敗したら「取得できませんでした」が出て `<table>` が出ない／`http` を含む外部参照が無い（`render-hook-decisions-html.test.sh` scenario 1〜7）
- ✅ `plugin-layout.json` に配る 2 本（集計）と配らない 2 本（HTML）が宣言され、`check-support-script-coverage.test.sh`・`check-plugin-check-coverage.test.sh`・`build-plugin.test.sh`・`check-plugin-integrity.test.sh` が緑
- ✅ `harness-registry.json` の H-07 に 2 本の `.test.sh`（集計・HTML。月次サマリの検査は既登録）が登録され、`render-harness-map.sh --check` が最新
- ✅ シェルテスト全件（`LC_ALL=C.UTF-8`）が緑（169 本 PASS / 0 FAIL。編集途中と最終状態の 2 回。PR #897 の 04 表）

実装中に見つけて直したこと（fixture では見えず、実物で初めて分かった）:

- `.mjs` の「自分が入口か」の判定を `path.resolve` で書くと、macOS の `mktemp -d`（`/var/folders` → `/private/var/folders` の symlink）配下から呼ばれたとき `main()` が**黙って走らず**、月次サマリの `|| true` が空出力を飲んで「取得できませんでした」に化けた。`realpathSync` 比較に直し、symlink 経由の回帰テストを足した（同じ書き方が他の `.mjs` 8 本に残っている。別件）
- 「止める力」を `permissionDecision` の語の有無で判定すると、`permissionDecision: "allow"` しか返さない警告 hook（`check-run-manifest-presence`）も deny / ask に見えた。値が deny / ask のものだけを拾い、コメント行は除いた
- 実走日をドリル文書の全行から拾うと、「期限が `maintenance-digest.sh` に載っていた」という散文の言及が、その節の見出しの日付（2026-09-11）を実走日として拾った。表の行に限定した

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 | 状態 |
| --- | --- | --- | --- | --- |
| 1 | ブランチの土台 | PR #896 のブランチ（`claude/vkumai-three-tasks-143744`）の上に積む。#896 が main に入ったら base を main に付け替える | 記録の形の正本（仕様書・記録部品）が #896 にしか無い。別々に main から切ると `plugin-layout.json`・`file-index.md` で確実に衝突する。#896 は現在の main を含んでいる（確認済み） | 承認（2026-10-18。実際は #896 が先にマージされたので、マージ後の origin/main を取り込んだ） |
| 2 | 集計本体の置き方 | `scripts/summarize-hook-decisions.sh`（入口）＋ `scripts/lib/hook-decisions-summary.mjs`（本体）。HTML 生成も同じ `.mjs` を import する | 既存の `summarize-gate-passfail.sh → lib/*.ts` と同じ「入口 ＋ lib」の形。`.ts` でなく `.mjs` にするのは、`check-harness-score.mjs` と同じで実験フラグが要らず、HTML 側と**同じ関数**で数えるため（テキストと HTML で件数がずれる道を作らない） | 承認（2026-10-18） |
| 3 | 表に切り替える閾値 | 期間内 10 件以上で表、9 件以下は 1 件 1 行 | 数件の表は「薄いダッシュボード」に見える。値は目安なので、使って合わなければ変える（定数 1 か所） | 承認（2026-10-18） |
| 4 | 配る／配らない | `summarize-hook-decisions.sh` ＋ `lib/hook-decisions-summary.mjs` は aidd-core と aidd-vkumai に配る（記録部品 `log-hook-decision.sh` と同じ先）。`render-hook-decisions-html.sh` ＋ `lib/render-hook-decisions-html.mjs` は配らない（`supportScriptsNotDistributed` に理由つき） | 月次サマリ hook は aidd-core で配られている。集計だけ配らないと、導入先で段落が黙って消える（PR #896 と同じ「運び忘れると記録が黙って無くなる」型）。HTML はこのリポジトリの `docs/agents/hook-live-drill.md` を読むので導入先では必ず空振りする。プラグインは「配れるもの」として一区切りしており、機能追加はしない方針 | 承認（2026-10-18） |
| 5 | 月次サマリの既存の門 | そのまま。`loop-observability.jsonl` が無い環境では月次サマリ全体が出ない（現状どおり） | 門を変えるのは別の判断。今回は段落を足すだけに留める。限界として明記する | 承認（2026-10-18） |
| 6 | 実走の最終記録日の取り方 | `hook-live-drill.md` の**表の行**（`\|` で始まる行）のうち hook 名を含むものについて、行内の日付とその表の `## 見出し` の日付の最大値。無ければ「記録なし」 | 実走の機械記録はまだ無く、作るのはこの PR の範囲外。近似であることを HTML に書く。散文まで見ると「期限が `maintenance-digest.sh` に載っていた」のような言及を実走として拾った（実装中に実測、表の行に限定した） | 承認（2026-10-18） |
| 7 | HTML の出力先 | `<共有 logs>/hook-decisions.html`（`--out` で変更可） | 他の機械記録と同じ場所・git 管理外。`logs/` は `.gitignore` 済み | 承認（2026-10-18） |

## 分かっていないこと

- 本物の記録が入り始めるのは PR #896 マージ後、メインのチェックアウトが追従してから。それまで実データでの確認は**できない**ので、受け入れは fixture のみ。実データで初めて見たときの違和感はこの仕様書に追記する
- `.codex/hooks.json` の hook は `"$(git rev-parse --show-toplevel)"/scripts/x.sh` の形で登録されている。`scriptNameOf` はこの形から名前を取り出せる（`hook-registry-hash.mjs` が同じ近似を使っている）が、形が変わると一覧から落ちる
- 月次サマリの段落は `node` が無い環境では「取得できませんでした」になる（既存の passfail 集計と同じ）

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 実装セット

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/lib/hook-decisions-summary.mjs` / `scripts/summarize-hook-decisions.sh` / `scripts/summarize-hook-decisions.test.sh` | 純粋関数 `summarizeDecisions(lines, {since, now})` → 上の JSON 構造。`formatText(summary, {tableThreshold})`。入口は `--log-file` / `--days` / `--json`。既定の記録先は `resolve_log_dir`。テストは fixture 13 行＋無い／空／期間外／少数／多数／壊れた行＋symlink 経由の起動 |
| B | `scripts/gate-effectiveness-monthly-check.sh` / `.test.sh` | `HOOK_DECISIONS_SUMMARY="$(bash "$SCRIPT_DIR/summarize-hook-decisions.sh" --days "$INTERVAL_DAYS" 2>/dev/null || true)"` を足し、MSG に「## 止める hook が止めた回（hook-decisions.jsonl＝機械記録）」節を追加。無ければ断り書き。scenario 7 を追加 |
| C | `scripts/lib/render-hook-decisions-html.mjs` / `scripts/render-hook-decisions-html.sh` / `scripts/render-hook-decisions-html.test.sh` | `--root`（既定: リポジトリルート）/ `--log-file` / `--days` / `--out` / `--score-cmd`（テスト注入用）。節 1 は A の関数、節 2 は `check-harness-score.mjs --summary` の TSV、節 3 は `collectHookCommands` ×  `existsSync(scripts/<name>.test.sh)` × ドリル文書の日付 × 節 1 の hook 別件数。HTML は文字列結合で生成し、値は必ずエスケープ |
| D | `scripts/lib/plugin-layout.json` / `scripts/lib/harness-registry.json` / `docs/agents/harness-map.md`（生成）/ `dist/plugins/**`（生成）/ `docs/agents/file-index.md` | 配布宣言・検査登録・索引 1 行。`bash scripts/build-plugin.sh` と `bash scripts/render-harness-map.sh` で生成物を更新 |

A → B・C は A の後（同じ関数を使う）。B と C は別ファイルなので同時に進められる。D は最後。

## 方針

- 集計関数は I/O を持たない（行の配列を受けて構造を返す）。入口 `.sh` と HTML が同じ関数を呼ぶ
- 「無い」「空」「期間外」「少数」「多数」は `fileState` と件数から機械的に分岐する。文言は 1 か所（`formatText`）に集める
- aidd-core に配るファイル（A）は禁止語を含めない。fixture の rule 名は `direct_exec` / `skip_marker` / `readonly_role` など中立な語彙だけを使い、`target` も `psql` 等にする
- HTML は `<table>` を節 1 の多数時と節 2・3 でのみ使う。節 1 の 0 件・少数時は `<p>` と `<ul>`。節 2 の取得失敗時は `<p>` の断り書きのみ
- `check-harness-score.mjs --summary` は違反があると exit 1 で TSV を出さない。その場合も「取得できませんでした（検査が違反を報告）」として扱い、表を出さない

## テスト観点

- fixture の件数を手で数えた期待値と突き合わせる（テキスト・JSON）
- 0 件 3 種（無い／空／期間外）の文言が互いに違うこと
- 閾値の両側（9 件と 10 件）で表の見出し行の有無が切り替わること
- 壊れた行: JSON 不正 1 行＋語彙外 decision 1 行 → `broken.count` に数え、他の件数は変わらない
- 月次サマリ: スクリプト有り／無しの両方（既存 scenario 5・6 の型）
- HTML: `.test.sh` 有り／無しの両方の hook を fixture に置く。ドリル文書に同じ hook の日付を 2 つ置いて最新を取ること。成績コマンドを `false` に差し替えて断り書きになること。`grep -c "http"` が 0
- 既存: `check-support-script-coverage.test.sh` / `check-plugin-check-coverage.test.sh` / `build-plugin.test.sh` / `check-plugin-integrity.test.sh` / シェルテスト全件

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし。製品コード（`src/` `supabase/`）に触れない。Next.js を使わない
- 新しい値: `fileState` の 3 値（present / missing / empty）、表の閾値 10、既定期間 30 日。本文の表と一致
- 列挙: 出口 3 つ、見せ方の状態 5 つ、HTML の節 3 つ、決めてほしいこと 7 件、受け入れ条件 10 件。本文と一致
- 信号の意味: 0 件を合格として出さない。壊れた行を黙って落とさない。自己申告（harness-score）と機械記録（hook-decisions）を同じ表に混ぜない
- 限界: 発火率の分母（allow の回数）は記録されないので出せない。実走日はドリル文書の近似。月次サマリの既存の門は変えない
