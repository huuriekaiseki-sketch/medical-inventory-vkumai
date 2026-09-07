#!/usr/bin/env bash
# WHY: issue #757 の 30（供給網の侵害シミュレーション）。「配布物を差し替えられたら気づけるか」を
#      文章で決めずに実測する。改ざんはすべて **一時ディレクトリのコピー** に対して行い、
#      リポジトリの追跡ファイルには一切触れない（演習が事故にならないようにする）。
#
#      各シナリオは「侵害を作る → 既存の検知器を回す → 検知できたか」を 1 行で報告する。
#      検知できないシナリオも**わざと残してある**（そこが穴なので、消さずに記録する）。
#
# 使い方:
#   bash scripts/supply-chain-drill.sh            # 全シナリオ
#   bash scripts/supply-chain-drill.sh <name>...  # 指定したシナリオだけ
#
# シナリオ:
#   plugin-swap     配布済みプラグインの 1 ファイルを書き換える
#   plugin-inject   配布済みプラグインに知らないファイルを差し込む
#   plugin-partial  配布物の一部だけ古い（ファイルが欠ける）
#   lockfile-swap   package-lock.json の resolved を別レジストリへ向ける
#   action-tag      GitHub Action の参照をタグのまま別コミットへ動かす（検知手段の有無を見る）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
gap=0
report() {
  # $1=シナリオ名 $2=detected|undetected $3=検知器 $4=一言
  if [ "$2" = "detected" ]; then
    echo "  ✅ $1: $3 が検知した（$4）"
    pass=$((pass+1))
  else
    echo "  ⚠️  $1: 検知できない（$3）。$4"
    gap=$((gap+1))
  fi
}

copy_plugin() {
  local dst="$WORK/$1"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$REPO_ROOT/dist/plugins/aidd-core/." "$dst/"
  echo "$dst"
}

run_scenario() {
  case "$1" in
    plugin-swap)
      local dir; dir="$(copy_plugin swap)"
      # 攻撃者が hook スクリプトの中に 1 行足す（配布経路で書き換えられた想定）
      printf '\n# injected by drill\n' >> "$dir/scripts/check-branch-pr-status.sh"
      if bash "$SCRIPT_DIR/check-plugin-integrity.sh" "$dir" >/dev/null 2>&1; then
        report "$1" undetected "check-plugin-integrity.sh" "manifest と突合しているのに素通りした。検知器の退行を疑う"
      else
        report "$1" detected "check-plugin-integrity.sh" "sha256 の不一致"
      fi
      ;;
    plugin-inject)
      local dir; dir="$(copy_plugin inject)"
      printf 'echo pwned\n' > "$dir/scripts/not-in-manifest.sh"
      if bash "$SCRIPT_DIR/check-plugin-integrity.sh" "$dir" >/dev/null 2>&1; then
        report "$1" undetected "check-plugin-integrity.sh" "manifest に無いファイルを見ていない"
      else
        report "$1" detected "check-plugin-integrity.sh" "manifest に無いファイル"
      fi
      ;;
    plugin-partial)
      local dir; dir="$(copy_plugin partial)"
      rm -f "$dir/scripts/check-recovery-queue.sh"
      if bash "$SCRIPT_DIR/check-plugin-integrity.sh" "$dir" >/dev/null 2>&1; then
        report "$1" undetected "check-plugin-integrity.sh" "欠落を見ていない"
      else
        report "$1" detected "check-plugin-integrity.sh" "ファイルの欠落"
      fi
      ;;
    lockfile-swap)
      local lock="$WORK/package-lock.json"
      cp "$REPO_ROOT/package-lock.json" "$lock"
      node -e '
        const fs = require("fs")
        const p = process.argv[1]
        const j = JSON.parse(fs.readFileSync(p, "utf8"))
        const key = Object.keys(j.packages ?? {}).find(k => (j.packages[k].resolved ?? "").includes("registry.npmjs.org"))
        if (!key) { console.error("resolved を持つ項目が無い"); process.exit(2) }
        j.packages[key].resolved = j.packages[key].resolved.replace("registry.npmjs.org", "registry.evil.example")
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
      ' "$lock" || { report "$1" undetected "check-lockfile-integrity.test.sh" "fixture を作れなかった"; return; }
      # 検知規則は check-lockfile-integrity.test.sh と同じ（resolved がすべて registry.npmjs.org 由来）
      if node -e '
        const fs = require("fs")
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        const bad = Object.entries(j.packages ?? {}).filter(([, v]) => v.resolved && !v.resolved.startsWith("https://registry.npmjs.org/"))
        process.exit(bad.length > 0 ? 1 : 0)
      ' "$lock"; then
        report "$1" undetected "check-lockfile-integrity.test.sh" "別レジストリの resolved を素通りした"
      else
        report "$1" detected "check-lockfile-integrity.test.sh" "registry.npmjs.org 以外の resolved"
      fi
      ;;
    action-tag)
      # GitHub Action はタグ（@v7 等）で参照している。タグは上流が動かせるので、
      # リポジトリ側のファイルは 1 バイトも変わらないまま実行されるコードだけが変わる。
      local tagrefs
      tagrefs="$(grep -rho 'uses: [a-z][^@]*@v[0-9]*' "$REPO_ROOT/.github/workflows/" 2>/dev/null | sort -u | wc -l | tr -d ' ')"
      if [ "$tagrefs" -gt 0 ]; then
        report "$1" undetected "（無し）" "外部 action ${tagrefs} 種をタグで参照している。commit SHA で固定するか、少なくとも棚卸しの対象にする"
      else
        report "$1" detected "（固定済み）" "外部 action をタグで参照していない"
      fi
      ;;
    *)
      echo "  不明なシナリオ: $1"
      gap=$((gap+1))
      ;;
  esac
}

SCENARIOS=("$@")
if [ "${#SCENARIOS[@]}" -eq 0 ]; then
  SCENARIOS=(plugin-swap plugin-inject plugin-partial lockfile-swap action-tag)
fi

echo "=== 供給網の侵害演習（issue #757 の 30） ==="
for s in "${SCENARIOS[@]}"; do run_scenario "$s"; done
echo "--- 検知 ${pass} 件 / 未検知 ${gap} 件 ---"
echo "未検知は docs/agents/supply-chain-drill.md の実施記録に残し、塞ぐか「引き受ける」を決める。"

# 演習そのものは常に成功扱い（未検知は「今わかっていること」であって、CI を止める理由ではない）
exit 0
