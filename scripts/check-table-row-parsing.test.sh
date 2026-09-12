#!/usr/bin/env bash
# WHY(2026-09-11): 「表の列の中にパイプを書きたければ `\|` と書いてよい」という緩和を
#      2026-09-09 に入れた。共通エンジン（scripts/lib/check-catalog.mjs の `splitRow`）は
#      その約束を知っているが、**同じ表を自前の `awk -F'|'` / `split('|')` で読む側には
#      広がっていなかった**（docs/agents/check-design-pitfalls.md の C-047）。
#
#      実測（2026-09-11）: 表を割っている 16 ファイルのうち、緩和に追いついていたのは 6 件。
#      残りは「いまその表に `\|` が無いから落ちていない」だけで、誰かが 1 つ書いた瞬間に
#      **列が 1 つずれた値を黙って読む**。実際 E-049 を書いたとき 1 件がそれで落ちた。
#
#      だから「緩和に追いついたか」を人の記憶に任せず、**自前の区切りが増えないこと自体**を門にする。
#      入口は 2 つだけ:
#        JS / TS  … `splitRow`（scripts/lib/check-catalog.mjs）
#        shell    … `table_field` / `table_nf` / `table_mask_stream`（scripts/lib/table-row.sh）
#
#   (a) 自前の区切りで表を割っている行が無い
#   (b) 走査が空振りしていない（対象のファイルを 1 本も見つけられなければ落とす。C-044）
#   (c) fixture で (a) を検知でき、正しい書き方を誤検知しない（RED 方向の自己検証。C-022）
#   (d) 入口そのものが 2 つとも実在する（片方を消したら落ちる）
#
# 限界:
#   - 見るのは**書き方**であって、その行が本当に Markdown の表を読んでいるかは見ない。
#     表と無関係に `|` で割りたい箇所が出てきたら誤検知する（2026-09-11 時点で 0 件）。
#     そのときは「表ではない」と分かる形（`-F'\t'` へ替える等）に直すか、ここに理由つきで除外を足す。
#   - `IFS='|' read` や `${var%%|*}` のような**別の割り方**は見ていない（実例が無い）。
#   - `awk -F'|'` を退避と同じ行／直前の行で使っているかだけを見る。
#     2 行以上離して書くと見逃す（そう書く理由が無いので許容する）。
#
# 実行: bash scripts/check-table-row-parsing.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を走査する（E-086・E-087）。実測: 導入先に `awk -F'|'` を置いても
#      プラグイン側の 146 ファイルを見て「自前の区切りは 0 件」と言っていた。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 走査対象のファイルを列挙する。$1=ルート
#
# WHY(ディレクトリ名を並べない。C-048): どこにソースを置くかは導入先ごとに違う。
#      名前を並べると、その並びに無い場所へ書かれた自前の区切りを黙って見逃す
#      （**走査の穴は、走査が緑のままなので気づけない**）。ルートから全部見て、
#      生成物・依存・見本だけを外す。
list_files() {
  local root="$1"
  [ -d "$root" ] || return 0
  find "$root" \
    -type d \( -name node_modules -o -name dist -o -name .next -o -name .git \
               -o -name worktrees -o -name coverage -o -name eval-fixtures \) -prune -o \
    -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' \) -print
}

# 自前の区切りで表を割っている行を 1 行ずつ出す。$1=ルート
find_bare_splits() {
  local root="$1" f rel
  while IFS= read -r f; do
    rel="${f#"$root"/}"
    case "$rel" in
      # WHY(自分自身を除く): この検査は違反の見本を fixture で作って走査に掛ける。
      #      その見本が自分の走査に当たると、自分を違反として数え続ける
      */check-table-row-parsing.test.sh) continue ;;
      # WHY(入口の回帰テストを除く): table-row.test.sh は「素の awk だと答えが変わる」ことを
      #      **対の実証として実際に動かす**（C-030）。その行は意図して素のまま置いてある
      */lib/table-row.test.sh) continue ;;
    esac
    awk -v file="$rel" '
      { cur = $0 }
      cur ~ /awk[ \t]+-F.?\|/ || cur ~ /cut[ \t]+-d.?\|/ || cur ~ /\.split\(.\|.\)/ {
        if (cur !~ /^[ \t]*#/ && cur !~ /^[ \t]*\/\// && cur !~ /^[ \t]*\*/ &&
            cur !~ /table_mask/ && cur !~ /splitRow/ &&
            prev !~ /table_mask/ && prev !~ /splitRow/)
          printf "%s:%d: %s\n", file, NR, substr(cur, 1, 110)
      }
      { prev = cur }
    ' "$f"
  done < <(list_files "$root")
}

echo "=== scenario 1: 入口が 2 つとも実在する ==="
# WHY(2026-09-12): 入口の実体は**配布物側**にあり、導入先の `scripts/lib/` には無いのが正常。
#      導入先で「入口が見つからない」を違反として読むと、正しく入れた導入先ほど赤くなる（E-086）。
#      入口を探す先は、この検査自身の隣（＝配布物なら配布物、中心リポジトリなら中心）にする。
ENTRY_JS="$SCRIPT_DIR/lib/check-catalog.mjs"
ENTRY_SH="$SCRIPT_DIR/lib/table-row.sh"
if grep -q 'export function splitRow' "$ENTRY_JS" 2>/dev/null; then
  assert_ok "JS / TS の入口: splitRow（$(basename "$ENTRY_JS")）"
else
  assert_fail "JS / TS の入口 splitRow が見つからない（消えたら全員が自前に戻る）"
fi
if grep -q '^table_field()' "$ENTRY_SH" 2>/dev/null; then
  assert_ok "shell の入口: table_field（$(basename "$ENTRY_SH")）"
else
  assert_fail "shell の入口 table_field が見つからない"
fi

echo "=== scenario 2: 実態に、自前の区切りで表を割っている行が無い ==="
OUT="$(find_bare_splits "$REPO_ROOT")"
if [ -z "$OUT" ]; then
  assert_ok "自前の区切りは 0 件"
else
  COUNT="$(wc -l <<<"$OUT" | tr -d ' ')"
  assert_fail "自前の区切りが ${COUNT} 箇所ある" "$(head -10 <<<"$OUT")
      直し方: JS / TS は splitRow(line)、shell は table_field \"\$line\" N / table_mask_stream | awk"
fi

echo "=== scenario 3: 走査が空振りしていない（C-044） ==="
COUNT_FILES="$(list_files "$REPO_ROOT" | wc -l | tr -d ' ')"
# WHY(2026-09-12): 下限 100 は大きなリポジトリを前提にしていた。配った先は小さい
#      （実測: 導入先を模した 2 リポジトリで 9 ファイルと 10 ファイル）。
#      持っていないだけで赤くなるので、0 件のときだけ落とす。
if [ "$COUNT_FILES" -eq 0 ]; then
  assert_fail "走査できたファイルが 0 件（走査が壊れているか、この導入先に対象がありません）"
else
  assert_ok "${COUNT_FILES} ファイルを走査できている"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts/lib" "$WORK/src"
cat > "$WORK/scripts/bad-shell.sh" <<'EOF'
#!/usr/bin/env bash
id="$(awk -F'|' '{print $2}' docs/agents/promise-catalog.md)"
n="$(cut -d'|' -f3 <<<"$line")"
EOF
cat > "$WORK/src/bad-js.ts" <<'EOF'
const cells = line.split('|').map((c) => c.trim())
EOF
cat > "$WORK/scripts/good-shell.sh" <<'EOF'
#!/usr/bin/env bash
source "$SCRIPT_DIR/lib/table-row.sh"
id="$(table_field "$line" 2)"
table_mask_stream "$doc" |
  awk -F'|' '{print $2}' |
  table_unmask_stream
# 例として書いた awk -F'|' はコメントなので対象外
EOF
cat > "$WORK/src/good-js.ts" <<'EOF'
import { splitRow } from '../scripts/lib/check-catalog.mjs'
const cells = splitRow(line)
const parts = other.split('\t')
EOF

OUT_F="$(find_bare_splits "$WORK")"
if grep -q 'scripts/bad-shell.sh:2' <<<"$OUT_F"; then
  assert_ok "shell の素の awk -F を検知"
else
  assert_fail "shell の素の awk -F を検知できない" "$OUT_F"
fi
if grep -q 'scripts/bad-shell.sh:3' <<<"$OUT_F"; then
  assert_ok "shell の素の cut -d を検知"
else
  assert_fail "shell の素の cut -d を検知できない" "$OUT_F"
fi
if grep -q 'src/bad-js.ts' <<<"$OUT_F"; then
  assert_ok "JS / TS の素の split を検知"
else
  assert_fail "JS / TS の素の split を検知できない" "$OUT_F"
fi
if grep -q 'good-' <<<"$OUT_F"; then
  assert_fail "正しい書き方を誤検知した" "$OUT_F"
else
  assert_ok "入口を通す書き方・コメント・タブ区切りは誤検知しない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
