#!/bin/bash
# WHY(2026-09-05): hook の警告文は「docs/agents/common.md「ブランチ運用ルール」を参照」のように docs の
#      節を指す。docs 側は圧縮・分割（issue #486 で common.md → tooling-decisions.md 等）で節が移動する
#      が、hook 文言は追従せず、古い場所を指したままになる（check-automode-config.sh が「common.md の
#      推奨 autoMode 設定」を指していたが、その節は tooling-decisions.md に移動済みだった実例）。
#      docs 間のリンクは check-docs-integrity.mjs が検査するが、hook 文言（bash 文字列）は対象外だった。
#      scripts/*.sh（テスト以外）から `docs/agents/<file>.md「<節名>」` を抽出し、ファイルの実在と
#      「節名を含む見出し行」の実在を検査する。
#
# 実行: bash scripts/check-hook-doc-pointers.test.sh
set -euo pipefail

# WHY: BSD grep（macOS の /usr/bin/grep）はロケール未指定だと `[^」]` のようなマルチバイトの否定文字
#      クラスを正しく扱えず、4 件中 2 件しか抽出しなかった（2026-09-05 実測。その状態では「壊れた参照
#      なし」が空振りで通ってしまう）。C.UTF-8 は macOS・Ubuntu の両方にある
export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOOK_DOC_POINTERS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# $1: root。テスト以外の scripts/*.sh から参照を抽出し、壊れているものを "file:line<TAB>pointer<TAB>reason" で出す
scan() {
  local root="$1" script pointer file heading line
  for script in "$root"/scripts/*.sh; do
    case "$script" in *.test.sh) continue ;; esac
    [ -f "$script" ] || continue
    grep -n -o 'docs/agents/[A-Za-z0-9_./-]*\.md「[^」]*」' "$script" 2>/dev/null | while IFS= read -r hit; do
      line="${hit%%:*}"
      pointer="${hit#*:}"
      file="${pointer%%「*}"
      heading="${pointer#*「}"
      heading="${heading%」}"
      if [ ! -f "$root/$file" ]; then
        printf '%s:%s\t%s\tファイルが無い\n' "$(basename "$script")" "$line" "$pointer"
        continue
      fi
      # 見出し行（# で始まる行）に節名が部分一致すれば OK。「## 次回実施予定日」のように節名が # を含む場合は剥がす
      heading="${heading#\#\#\# }"; heading="${heading#\#\# }"; heading="${heading#\# }"
      if ! grep -E '^#{1,6} ' "$root/$file" | grep -qF -- "$heading"; then
        printf '%s:%s\t%s\t見出しが無い\n' "$(basename "$script")" "$line" "$pointer"
      fi
    done || true
  done
  # WHY: 最後のスクリプトに参照が無いと grep の exit 1 が関数の戻り値になり、set -e で呼び出し元が
  #      無言で落ちる（scenario 2 で実際に起きた）。抽出結果は stdout で返すので戻り値は常に 0
  return 0
}

echo "=== scenario 1: 実態の hook 文言が指す docs の節がすべて実在する ==="
BROKEN="$(scan "$ROOT")"
if [ -z "$BROKEN" ]; then
  ok "壊れた参照なし"
else
  ng "hook 文言が指す docs の節が見つからない（節の移動・改名に hook 文言が追従していない）" "$BROKEN"
fi

echo "=== scenario 2: 壊れた参照を仕込むと検知する（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts" "$WORK/docs/agents"
printf '# doc\n\n## 実在する節\n本文\n' > "$WORK/docs/agents/x.md"
printf 'MSG="docs/agents/x.md「実在する節」を参照"\n' > "$WORK/scripts/good.sh"
printf 'MSG="docs/agents/x.md「消えた節」と docs/agents/gone.md「節」を参照"\n' > "$WORK/scripts/bad.sh"
printf 'MSG="docs/agents/x.md「消えた節」"\n' > "$WORK/scripts/bad.test.sh"
RED="$(scan "$WORK")"
if printf '%s' "$RED" | grep -qF 'bad.sh:1'; then ok "消えた節を検知"; else ng "消えた節を検知できない" "$RED"; fi
if printf '%s' "$RED" | grep -qF 'gone.md'; then ok "無いファイルを検知"; else ng "無いファイルを検知できない" "$RED"; fi
if printf '%s' "$RED" | grep -qF 'good.sh'; then ng "実在する参照を誤検知" "$RED"; else ok "実在する参照は誤検知しない"; fi
if printf '%s' "$RED" | grep -qF 'bad.test.sh'; then ng "テストファイルまで対象にしている"; else ok "テストファイルは対象外"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
