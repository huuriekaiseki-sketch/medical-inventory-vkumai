# ハーネス凍結（このファイルが HEAD にある間、有効）

**このファイルの存在そのものがスイッチ。** `scripts/git-hooks/commit-msg` は HEAD にこのファイルが
あると、`src/` `supabase/` `e2e/` に 1 ファイルも触れないコミットを止める（H-014）。
凍結を解くときは、このファイルを消すコミットを入れる（そのコミットだけは通る）。

## なぜ（2026-09-13）

2026-09-11 に外部レビューを受けて「ハーネスの育成は終わり、製品 issue で『止めた / 見逃した / 邪魔した』を
記録する証明フェーズへ移る」と決めた。決めた後の 48 コミットのうち、製品コードに触れたのは 1 件だった。
取りこぼし台帳は E-092、`docs/agents/` は 57 文書、`scripts/` は約 250 本。cardiosearch で起きた
「6 日 239 コミット中 src/ が 1.3%」と同じ形に入っていた。

人の決意は 2 日で消えたので、決めごとをコミットの入口で機械に持たせる
（[`check-design-pitfalls.md`](./check-design-pitfalls.md) の「検知を賢くするより、間違えられる道を無くす」）。

## 通るもの・止まるもの

| コミット | 扱い |
| --- | --- |
| `src/` `supabase/` `e2e/` のどれかに 1 ファイルでも触れる | 通る（一緒に docs・scripts を変えるのは自由） |
| docs・scripts・`.claude/` だけ | **止まる** |
| マージコミット（`MERGE_HEAD` あり） | 通る（`recovery/local-main` の合流を邪魔しない） |
| `--allow-empty` | 通る |
| このファイルを消すコミット | 通る（凍結の解除） |

横を通る道は 1 つ: `git commit --no-verify` のあと
`bash scripts/log-manual-override.sh --safeguard H-014 --actor <名前> --reason "<理由>"`。

## 解く条件

製品 issue 3 本（vkumai）について、issue ごとに「ハーネスが止めた / 見逃した / 邪魔した」を 1 行ずつ
記録し終えたとき。記録先は各 issue の PR 本文 03 欄。

## 限界

- hook は clone ごとに入れるもの（`bash scripts/install-git-hooks.sh`）。入っていない clone では何も起きない。
  **worktree ごとの設定（`extensions.worktreeConfig` が有効なので `.git/worktrees/<名前>/config.worktree`）が
  clone の設定を上書きできる。** 2026-09-13 に、worktree `remaining-tasks-check-f3afd7` の `config.worktree` に
  `core.hooksPath` がメイン checkout の絶対パス（research ブランチで、そのディレクトリは無い）で入っていて、
  **その worktree では commit-msg も pre-push も一度も動いていなかった**（git は存在しない hooksPath を黙って
  無視する。C-044 の型。誰が書いたかは分かっていない）。clone の設定（相対）は正しく、他の worktree では動いていた。
  worktree で作業を始めたら `git config --show-scope --get-all core.hooksPath` を打ち、`worktree` スコープの行が
  無いこと（あれば `git config --worktree --unset core.hooksPath`）を確かめる。**この検査は機械化していない。**
- 「src/ に 1 行だけ触れて通す」ことはできる。止めるのは無意識の逸脱で、意図した迂回は H-014 の記録に頼る。
- 判定はパスの接頭辞だけ。`src/` 配下のテストだけを変えたコミットも「製品」と数える。
