#!/usr/bin/env bash
# WHY: issue #757 の 37（配布物の同一性）。生成の決定性（build-plugin.sh --check）は
#      「中心リポジトリの dist/plugins が正本から作れる」ことしか言わない。配布経路
#      （marketplace リポジトリ・git clone・手コピー）で差し替えられた・部分적に古い・
#      導入先で手編集された、は検知できなかった（blast-radius.md の B-022）。
#
#      build-plugin.sh が各プラグインの直下に .aidd-manifest.json（全ファイルの sha256）を
#      書くので、ここではそれと実物を突き合わせる。
#        - 中心リポジトリ: dist/plugins/* を検査（CI の hooks-test）
#        - 導入先: SessionStart hook として $CLAUDE_PLUGIN_ROOT を検査
#
#      **これは改ざんの証明ではない**。manifest ごと書き換えられたら気づけない（署名が要る）。
#      検知できるのは「部分的な差し替え・欠落・手編集」まで。署名は #757-30 の供給網演習と同時に判断する。
#
# 使い方:
#   bash scripts/check-plugin-integrity.sh                 # dist/plugins/* を全部見る
#   bash scripts/check-plugin-integrity.sh <plugin-dir>... # 指定したディレクトリを見る
#   CLAUDE_PLUGIN_ROOT=... bash scripts/check-plugin-integrity.sh   # 導入先（SessionStart hook）
#
# 出力: 不一致があれば systemMessage 相当の警告を stdout に出し、exit 1（hook としては warning-only）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_NAME=".aidd-manifest.json"

sha_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# $1=プラグインのディレクトリ。不一致を stdout に 1 行ずつ出し、件数を返す
check_plugin() {
  local dir="$1" manifest="$1/$MANIFEST_NAME" problems=0 rel want got
  if [ ! -f "$manifest" ]; then
    echo "  manifest が無い: $dir/${MANIFEST_NAME}（build-plugin.sh で生成し直す）"
    return 1
  fi
  # manifest に載っているファイルの照合
  while IFS=$'\t' read -r rel want; do
    [ -n "$rel" ] || continue
    if [ ! -f "$dir/$rel" ]; then
      echo "  欠落: $rel"
      problems=$((problems+1))
      continue
    fi
    got="$(sha_of "$dir/$rel")"
    if [ "$got" != "$want" ]; then
      echo "  内容が違う: $rel"
      problems=$((problems+1))
    fi
  done < <(node -e '
    const fs = require("fs")
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    for (const [k, v] of Object.entries(m.files ?? {})) process.stdout.write(k + "\t" + v + "\n")
  ' "$manifest")

  # manifest に無いファイル（差し込まれたもの）
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    [ "$rel" = "$MANIFEST_NAME" ] && continue
    if ! node -e '
      const fs = require("fs")
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      process.exit((m.files ?? {})[process.argv[2]] ? 0 : 1)
    ' "$manifest" "$rel"; then
      echo "  manifest に無い: $rel"
      problems=$((problems+1))
    fi
  done < <(cd "$dir" && find . -type f -print | sed 's|^\./||' | sort)

  return "$problems"
}

targets=()
if [ "$#" -gt 0 ]; then
  targets=("$@")
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  targets=("$CLAUDE_PLUGIN_ROOT")
else
  dist="$(cd "$SCRIPT_DIR/.." && pwd)/dist/plugins"
  if [ ! -d "$dist" ]; then
    exit 0
  fi
  while IFS= read -r d; do targets+=("$d"); done < <(find "$dist" -mindepth 1 -maxdepth 1 -type d | sort)
fi

total=0
report=""
for dir in "${targets[@]}"; do
  [ -d "$dir" ] || continue
  out="$(check_plugin "$dir")"
  n=$?
  if [ "$n" -ne 0 ]; then
    report="${report}$(basename "$dir"):
$out
"
    total=$((total+n))
  fi
done

if [ "$total" -eq 0 ]; then
  exit 0
fi

printf '配布物の同一性: %d 件の不一致（issue #757 の 37）\n%s' "$total" "$report"
printf 'やること: 中心リポジトリなら bash scripts/build-plugin.sh で作り直してコミットする。\n'
printf '導入先なら再インストールする（手編集していたら正本へ持ち帰る）。\n'
exit 1
