# PFA医療機器インテリジェンス初回検証 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2025-07-28〜2026-07-28のPFA関連情報を収集・照合・採点し、最大10件の構造化データと、上位3件および最高評価1件の詳細記事を含む日本語HTMLを作成する。

**Architecture:** Web検索と直接ページ確認で話題を収集し、同一発表・同一研究をクラスタリングしてから、承認済みの4軸スコアで順位付けする。構造化データ `items.json` を正本とし、その内容を単一の静的HTML `report.html` に反映する。既存のNext.js・Supabase・認証・ニュース機能は変更しない。

**Tech Stack:** Codex Web検索・ブラウザ、公開Web情報、JSON、静的HTML/CSS、Node.jsによる決定的検証、ブラウザによる表示確認。

## Global Constraints

- 対象期間は `2025-07-28` から `2026-07-28` までとする。
- PFAを主対象とし、RF、cryo、マッピングなどはPFAの比較・理解に必要な場合だけ含める。
- Abbott「Volt」は通常候補として扱い、必須採用や点数優遇を行わない。
- 候補は重複しない話題を最大10件とし、件数合わせで低関連情報を追加しない。
- 各評価軸は0〜5点とし、`総合点 = 臨床点×8 + 新規性点×5 + 根拠点×4 + 代理店点×3` で100点満点に換算する。
- メーカーの主張、規制上確認できる事実、研究結果を分離して記録する。
- 本文を取得できないページは、スニペットだけで本文を読んだように要約しない。
- 重要な主張には直接到達できる出典URLを付け、長い原文引用は行わない。
- 不明な承認地域、対象疾患、研究デザイン、数値を推測で補わない。
- 出典の `accessStatus` は `full`、`abstract`、`snippet`、`blocked` のいずれかとする。
- 作成・変更する成果物は `research/pfa/2026-07-28/` 配下のみに置く。
- `src/`、`supabase/`、環境変数、既存ニュースページには触れない。

---

### Task 1: 候補探索・重複統合・価値スコアリング

**Files:**
- Create: `research/pfa/2026-07-28/items.json`

**Interfaces:**
- Consumes: 対象期間、情報源の優先順位、4軸価値スコア。
- Produces: 1〜10件の順位付き話題を保持するJSON。Task 2とTask 3はこのファイルを正本として使う。

- [ ] **Step 1: 企業・規制・研究・専門ニュースを分けて検索する**

次の検索を、1回につき最大4クエリで実行する。

```text
"pulsed field ablation" 2025 2026 device approval clinical trial
"pulsed field ablation" new catheter 2025 2026
site:fda.gov "pulsed field ablation"
site:pubmed.ncbi.nlm.nih.gov "pulsed field ablation" 2025 2026

site:clinicaltrials.gov "pulsed field ablation"
site:abbott.com "pulsed field ablation"
site:medtronic.com "pulsed field ablation"
site:bostonscientific.com "pulsed field ablation"

site:jnj.com "pulsed field ablation"
site:jnjmedtech.com "pulsed field ablation"
"pulsed field ablation" "Heart Rhythm" 2025 2026
"pulsed field ablation" electrophysiology news 2025 2026
```

検索結果から、規制当局、企業一次発表、臨床試験登録、査読論文、EP専門ニュース、医療機器業界ニュースの順でページを開く。

- [ ] **Step 2: 各候補ページを直接確認する**

各候補について次を確認する。

```text
原題
公開日
発行主体
製品・企業
対象疾患
対象地域
情報種別
研究デザイン
症例数
主要評価項目
追跡期間
メーカーの主張
独立して確認できる事実
不明点・限界
ページを全文、抄録、スニペットのどこまで読めたか
```

2025-07-28より前のページは、期間内の話題を理解するための補助出典には使えるが、独立した候補として数えない。

- [ ] **Step 3: 同じ話題をクラスタリングする**

同じ製品発表、規制承認、研究、学会発表を扱う複数ページを1件にまとめる。一次情報を `primarySource`、追加の照合先を `supportingSources` に置く。同一企業でも異なる承認、異なる研究、異なる追跡結果は別件として扱う。

- [ ] **Step 4: 各話題を採点して順位を決める**

各軸を整数0〜5点で採点し、総合点を計算する。同点の場合は、`clinicalImpact`、`evidenceReliability`、`publishedAt`の新しい順で順位を決める。

```text
clinicalImpact: 臨床現場への影響
noveltyTrend: 新規性・製品トレンド
evidenceReliability: 根拠の信頼性
distributorMarket: 代理店・市場の観点
total: clinicalImpact×8 + noveltyTrend×5 + evidenceReliability×4 + distributorMarket×3
```

- [ ] **Step 5: `items.json` を作成する**

トップレベルと各要素を次の形で記録する。`items` は `rank` 昇順に並べる。

```json
{
  "metadata": {
    "generatedAt": "2026-07-28",
    "coverageStart": "2025-07-28",
    "coverageEnd": "2026-07-28",
    "focus": "PFAを主軸とするカテーテルアブレーション関連医療機器情報",
    "scoringWeights": {
      "clinicalImpact": 40,
      "noveltyTrend": 25,
      "evidenceReliability": 20,
      "distributorMarket": 15
    }
  },
  "items": [
    {
      "id": "published-date-company-topic",
      "rank": 1,
      "titleJa": "日本語タイトル",
      "titleOriginal": "Original title",
      "summaryJa": "話題の要約",
      "publishedAt": "2026-01-01",
      "companies": ["Company"],
      "products": ["Product"],
      "conditions": ["Atrial fibrillation"],
      "regions": ["United States"],
      "informationType": "regulatory",
      "evidenceType": "regulatory-decision",
      "primarySource": {
        "title": "Source title",
        "publisher": "Publisher",
        "url": "https://example.com/source",
        "accessStatus": "full"
      },
      "supportingSources": [
        {
          "title": "Supporting title",
          "publisher": "Publisher",
          "url": "https://example.com/supporting",
          "accessStatus": "abstract"
        }
      ],
      "manufacturerClaims": ["メーカーが述べている内容"],
      "verifiedFacts": ["一次情報または研究で確認できた内容"],
      "uncertainties": ["未確定事項または限界"],
      "scores": {
        "clinicalImpact": 5,
        "noveltyTrend": 5,
        "evidenceReliability": 4,
        "distributorMarket": 4,
        "total": 93
      },
      "scoreRationale": "4軸の採点理由",
      "selectionReasonJa": "",
      "featured": false,
      "tags": ["PFA", "regulatory"],
      "detailedArticle": null
    }
  ]
}
```

実データでは例示文字列を残さず、確認した内容へ置き換える。

- [ ] **Step 6: JSONの構造・期間・点数を検証する**

Run:

```bash
node -e 'const fs=require("fs"),a=require("assert");const p="research/pfa/2026-07-28/items.json";const d=JSON.parse(fs.readFileSync(p,"utf8"));a.equal(d.metadata.coverageStart,"2025-07-28");a.equal(d.metadata.coverageEnd,"2026-07-28");a(d.items.length>=1&&d.items.length<=10);a.equal(new Set(d.items.map(x=>x.id)).size,d.items.length);d.items.forEach((x,i)=>{a.equal(x.rank,i+1);a(x.publishedAt>="2025-07-28"&&x.publishedAt<="2026-07-28");["clinicalImpact","noveltyTrend","evidenceReliability","distributorMarket"].forEach(k=>a(Number.isInteger(x.scores[k])&&x.scores[k]>=0&&x.scores[k]<=5));a.equal(x.scores.total,x.scores.clinicalImpact*8+x.scores.noveltyTrend*5+x.scores.evidenceReliability*4+x.scores.distributorMarket*3);a(/^https?:\/\//.test(x.primarySource.url));});console.log("items.json PASS")'
```

Expected: `items.json PASS`

- [ ] **Step 7: 候補データをコミットする**

```bash
git add research/pfa/2026-07-28/items.json
git commit -m "research: PFA関連候補を収集して採点"
```

---

### Task 2: 上位3件の照合と最高評価1件の記事化

**Files:**
- Modify: `research/pfa/2026-07-28/items.json`

**Interfaces:**
- Consumes: Task 1の順位付き `items`。
- Produces: 上位3件の選定理由と、最高評価1件の `detailedArticle`。Task 3がHTMLへ反映する。

- [ ] **Step 1: 上位3件を追加検索する**

各話題について、製品名、研究名、規制番号、論文名のうち確認できた固有名を使い、一次情報と独立情報を追加検索する。最高評価1件は、可能な限り一次情報を含む2件以上の読めたソースで照合する。

- [ ] **Step 2: 数値と研究条件を原文で照合する**

症例数、主要評価項目、成功率、有害事象率、追跡期間、比較群、対象疾患、承認地域を確認する。ニュース記事と一次情報で数値が異なる場合は一次情報を優先し、差異を `uncertainties` に記録する。

- [ ] **Step 3: 再採点して順位を確定する**

追加情報で根拠の質や臨床的意味が変わった場合は再採点する。同じ同点処理を適用し、`rank` を1から振り直す。1位だけ `featured: true`、それ以外は `featured: false` にする。

- [ ] **Step 4: 上位3件の選定理由を書く**

`rank` 1〜3の `selectionReasonJa` に、点数の言い換えではなく「なぜ今読む価値があるか」を2〜4文で記載する。4位以下は空文字のままとする。

- [ ] **Step 5: 1位の詳細記事を構造化する**

1位の `detailedArticle` を次の形で作成する。他の候補は `null` のままにする。

```json
{
  "headline": "記事見出し",
  "lede": "最初に読むべき結論",
  "background": ["技術・製品・臨床上の背景"],
  "whatHappened": ["今回確認できた出来事"],
  "evidenceSummary": ["研究デザインと主要結果"],
  "clinicalInterpretation": ["臨床現場から見た意味"],
  "distributorInterpretation": ["代理店・導入支援から見た意味"],
  "knownUnknowns": ["分かっていることと未確定事項"],
  "takeaways": ["今後追跡すべき点"]
}
```

- [ ] **Step 6: 上位選定と詳細記事を検証する**

Run:

```bash
node -e 'const fs=require("fs"),a=require("assert");const d=JSON.parse(fs.readFileSync("research/pfa/2026-07-28/items.json","utf8"));const top=d.items.filter(x=>x.rank<=3);a.equal(top.length,Math.min(3,d.items.length));top.forEach(x=>a(x.selectionReasonJa.trim().length>0));const f=d.items.filter(x=>x.featured);a.equal(f.length,1);a.equal(f[0].rank,1);a(f[0].supportingSources.length>=1);const z=f[0].detailedArticle;a(z&&z.headline&&z.lede);["background","whatHappened","evidenceSummary","clinicalInterpretation","distributorInterpretation","knownUnknowns","takeaways"].forEach(k=>a(Array.isArray(z[k])&&z[k].length>0));console.log("editorial data PASS")'
```

Expected: `editorial data PASS`

- [ ] **Step 7: 編集済みデータをコミットする**

```bash
git add research/pfa/2026-07-28/items.json
git commit -m "research: PFA上位候補を照合して記事化"
```

---

### Task 3: スタンドアロンHTMLレポート

**Files:**
- Create: `research/pfa/2026-07-28/report.html`

**Interfaces:**
- Consumes: Task 2で完成した `items.json`。
- Produces: ブラウザで単体閲覧できる日本語HTML。Task 4がJSONとの一致と表示を検証する。

- [ ] **Step 1: HTMLの骨格とデザインを作る**

外部CSS・外部JavaScriptに依存しない単一HTMLとし、次を実装する。

```text
header: 対象期間、主題、候補件数
trend-summary: 今回見えた重要トレンド
candidate-table: 最大10件の順位、日付、話題、情報種別、総合点、タグ
top-three: 上位3件の要約、4軸点数、選定理由、出典
featured-article: 1位の詳細記事
known-unknowns: 分かっていること／未確定なこと
methodology: 情報源、重複統合、採点式
sources: 全候補の一次・補助出典
disclaimer: 個人学習用の情報整理であり診療判断を指示しない
```

背景は白〜淡いグレー、本文は濃紺、アクセントはPFAを想起させる青緑とする。本文幅、行間、余白を十分に取り、モバイルでは表を横スクロール可能にする。

- [ ] **Step 2: JSONの全候補をHTMLへ反映する**

候補一覧の各行またはカードに `data-item-id="<items.jsonのid>"`、
`data-rank="<rank>"`、`data-score="<scores.total>"` を付ける。
点数、順位、URL、日付、タグはJSONと同じ値を使う。出典リンクには
`target="_blank"` と `rel="noopener noreferrer"` を付ける。

- [ ] **Step 3: 上位3件と詳細記事を反映する**

上位3件は選定理由を表示する。1位は `detailedArticle` の全7要素を見出しごとに表示し、メーカー主張、確認済み事実、未確定事項を別ブロックにする。

- [ ] **Step 4: HTMLの必須セクションと候補件数を検証する**

Run:

```bash
node -e 'const fs=require("fs"),a=require("assert");const d=JSON.parse(fs.readFileSync("research/pfa/2026-07-28/items.json","utf8"));const h=fs.readFileSync("research/pfa/2026-07-28/report.html","utf8");["今回の重要トレンド","候補一覧","上位3件","臨床的に分かっていること","代理店・導入現場から見た意味","調査方法","出典"].forEach(s=>a(h.includes(s),s));d.items.forEach(x=>{a(h.includes(`data-item-id="${x.id}"`),x.id);a(h.includes(`data-rank="${x.rank}"`),`rank:${x.id}`);a(h.includes(`data-score="${x.scores.total}"`),`score:${x.id}`);a(h.includes(x.publishedAt),`date:${x.id}`);a(h.includes(x.primarySource.url),`url:${x.id}`);});a.equal((h.match(/data-item-id="/g)||[]).length,d.items.length);console.log("report.html structure PASS")'
```

Expected: `report.html structure PASS`

- [ ] **Step 5: HTMLをコミットする**

```bash
git add research/pfa/2026-07-28/report.html
git commit -m "docs: PFA医療機器インテリジェンスレポートを作成"
```

---

### Task 4: 出典・整合性・表示の最終品質ゲート

**Files:**
- Modify if needed: `research/pfa/2026-07-28/items.json`
- Modify if needed: `research/pfa/2026-07-28/report.html`

**Interfaces:**
- Consumes: 完成したJSONとHTML。
- Produces: 出典追跡可能で、JSONとHTMLが一致し、ブラウザで読める最終成果物。

- [ ] **Step 1: 出典を再確認する**

上位3件の一次URLと補助URLを再度開く。記事中の製品名、企業名、日付、地域、対象疾患、症例数、主要結果が出典と一致することを確認する。取得不能になったURLは `accessStatus` と本文の注記を更新する。

- [ ] **Step 2: JSON検証を再実行する**

Task 1 Step 6とTask 2 Step 6の2コマンドを再実行する。

Expected:

```text
items.json PASS
editorial data PASS
```

- [ ] **Step 3: HTML整合性検証を再実行する**

Task 3 Step 4のコマンドを再実行する。

Expected: `report.html structure PASS`

- [ ] **Step 4: ブラウザで表示を確認する**

Run:

```bash
python3 -m http.server 4310 --directory research/pfa/2026-07-28
```

ブラウザで `http://localhost:4310/report.html` を開き、次を確認する。

```text
デスクトップ幅で本文が読みやすい
モバイル幅で横方向にページ全体がはみ出さない
候補表だけが必要に応じて横スクロールする
上位3件と詳細記事の階層が視覚的に区別できる
長いURLがレイアウトを壊さない
すべての出典リンクがクリック可能
```

確認後、HTTPサーバーを停止する。

- [ ] **Step 5: 医療情報の最終レビューを行う**

次の語調・区別を確認する。

```text
メーカー発表を臨床的確立事項として断定していない
単群研究を比較試験のように表現していない
急性成功と長期再発抑制を混同していない
技術的成功と患者アウトカムを混同していない
承認地域を日本国内の承認と誤読できる表現にしていない
未確定事項を明示している
個人学習用であり診療判断を指示しないと明示している
```

- [ ] **Step 6: 修正があった場合だけ最終コミットを作成する**

```bash
git add research/pfa/2026-07-28/items.json research/pfa/2026-07-28/report.html
git commit -m "fix: PFAレポートの出典と表示を最終確認"
```

修正がなければ新しいコミットは作成しない。

---

### Task 5: ユーザーによる価値判定

**Files:**
- Read: `research/pfa/2026-07-28/report.html`
- Read: `research/pfa/2026-07-28/items.json`

**Interfaces:**
- Consumes: Task 4の検証済み成果物。
- Produces: 初回検証の成否と、次回の価値スコア調整に使うユーザーフィードバック。

- [ ] **Step 1: 成果物を提示する**

`report.html` と `items.json` の絶対パスをクリック可能なリンクで提示し、
候補数、上位3件のタイトル、1位の総合点を短く報告する。

- [ ] **Step 2: 上位3件の価値を確認する**

ユーザーに次の1問を提示する。

```text
上位3件のうち、今後も保存したい情報はありましたか。
ある場合は順位またはタイトル、ない場合は「なし」と、その理由を教えてください。
```

- [ ] **Step 3: 初回検証の成功を判定する**

1件以上が「保存したい」と評価された場合は、初回検証の成功基準を満たしたと判定する。
0件の場合は失敗として扱い、臨床・新規性・根拠・代理店のどの採点軸がユーザー判断とずれたかを整理する。

- [ ] **Step 4: 次段階の範囲を分離する**

初回検証の評価だけを報告し、自動収集、定期実行、Next.js、データベース、ログインは開始しない。
ユーザーが次段階を明示的に依頼した場合に、今回のフィードバックを使って別設計を作る。
