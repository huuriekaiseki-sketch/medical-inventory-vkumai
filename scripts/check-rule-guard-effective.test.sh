#!/bin/bash
# WHY: `scripts/lib/check-rule-guard-coverage.mjs` は「ルールの節を名指しする検査があるか」しか見ない。
# **名指しは文字列で書けてしまう**ので、それだけでは「本当に守っているか」の証明にならない
# （同ファイルの既知の限界の筆頭）。
#
# 当初は「そのテストに『RED 方向』と書いてあること」を要求しようとしたが、**やめた**。
# 実測すると 11 本とも RED 方向のシナリオを実際に持っていて、語句が違うだけだった
# （「supabase db execute → deny」「マージ済みPRあり → 警告を出す」等）。
# 語句を要求しても**文字列一致を 1 段上に移すだけ**で、直したかった弱さと同じものになる。
#
# 代わりに振る舞いで測る: **検査本体を no-op（`exit 0` だけ）に置き換えて、そのテストが落ちるか。**
# 落ちるなら、そのテストは検査の「存在」ではなく「振る舞い」を見ている。
# ミューテーションテスト（docs/agents/mutation-testing.md）と同じ考え方を、shell の hook に
# 1 変異だけ適用したもの。
#
# 実行: bash scripts/check-rule-guard-effective.test.sh
#       RULE_GUARD_EFFECTIVE_ONLY=<name> で 1 本だけ測る
set -uo pipefail

export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

# ルールの節を名指ししている検査を機械で拾う（一覧を手で持たない）
# WHY(登録簿から対象を取る、2026-09-09): 以前は `common.md` を直書きしていた。
#      ルールの文書名は導入先ごとに違うので、共通側へ配れなかった。
#      エンジンと同じ登録簿（scripts/lib/rule-guard-registry.json）から文書名を取る。
GUARDS="$(cd "$ROOT" && node -e '
import("./scripts/lib/check-rule-guard-coverage.mjs").then(async (m) => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const docs = m.loadRegistry(process.cwd()).ruleDocs.map((d) => path.basename(d))
  const pointer = new RegExp("(" + docs.map((d) => d.replace(/\./g, "\\.")).join("|") + ")」?\\)?「")
  const names = new Set()
  for (const f of fs.readdirSync("scripts")) {
    if (!f.endsWith(".sh") || f.endsWith(".test.sh")) continue
    const t = fs.readFileSync("scripts/" + f, "utf8")
    if (pointer.test(t)) {
      if (fs.existsSync("scripts/" + f.replace(/\.sh$/, ".test.sh"))) names.add(f.replace(/\.sh$/, ""))
    }
  }
  console.log([...names].sort().join("\n"))
})')"

if [ -n "${RULE_GUARD_EFFECTIVE_ONLY:-}" ]; then
  GUARDS="$RULE_GUARD_EFFECTIVE_ONLY"
fi

if [ -z "$GUARDS" ]; then
  ng "ルールの節を名指しする検査が 1 本も見つからない（抽出が壊れている疑い）"
  echo "FAILED"
  exit 1
fi

count="$(printf '%s\n' "$GUARDS" | grep -c .)"
echo "=== ルールを守る検査 $count 本を no-op に置き換えて、テストが落ちるかを測る ==="

# 本物のリポジトリは触らない。scripts/ だけ複製し、残りは symlink で見せる
make_sandbox() {
  local tmp="$1"
  mkdir -p "$tmp/repo"
  cp -R "$ROOT/scripts" "$tmp/repo/scripts"
  local e
  for e in docs .claude .github aidd.config.json package.json package-lock.json \
           node_modules supabase src e2e .gitattributes CLAUDE.md AGENTS.md; do
    [ -e "$ROOT/$e" ] && ln -s "$ROOT/$e" "$tmp/repo/$e"
  done
}

while IFS= read -r name; do
  [ -n "$name" ] || continue
  tmp="$(mktemp -d)"
  make_sandbox "$tmp"

  # (a) 素の複製で通ること。通らないなら測定そのものが無意味なので、そう言う
  if ! (cd "$tmp/repo" && bash "scripts/$name.test.sh" >/dev/null 2>&1); then
    ng "$name: 複製した環境で素のまま落ちる（測定できない）" \
       "scripts/ の外を参照している可能性。make_sandbox の symlink 対象を足すか、テスト側に注入口を用意する"
    rm -rf "$tmp"
    continue
  fi

  # (b) 検査を no-op にしたら落ちること
  printf '#!/bin/bash\nexit 0\n' > "$tmp/repo/scripts/$name.sh"
  chmod +x "$tmp/repo/scripts/$name.sh"
  if (cd "$tmp/repo" && bash "scripts/$name.test.sh" >/dev/null 2>&1); then
    ng "$name: 検査を no-op にしてもテストが通る" \
       "そのテストは検査の存在しか見ていない。違反する入力を与えて警告・deny を確かめるシナリオを足すこと"
  else
    ok "$name: no-op にすると落ちる（振る舞いを見ている）"
  fi
  rm -rf "$tmp"
done <<< "$GUARDS"

echo "=== この検査自身の自己検証（RED 方向） ==="
# 「no-op にしても落ちないテスト」を仕込んで、上のループが検知することを確かめる
tmp="$(mktemp -d)"
make_sandbox "$tmp"
cat > "$tmp/repo/scripts/dummy-guard.sh" <<'SH'
#!/bin/bash
echo "何かする"
SH
cat > "$tmp/repo/scripts/dummy-guard.test.sh" <<'SH'
#!/bin/bash
# 検査の「存在」しか見ていないテスト（no-op でも通ってしまう）
set -euo pipefail
[ -f "$(dirname "${BASH_SOURCE[0]}")/dummy-guard.sh" ] && echo "ALL PASSED"
SH
chmod +x "$tmp/repo/scripts/dummy-guard.sh" "$tmp/repo/scripts/dummy-guard.test.sh"
printf '#!/bin/bash\nexit 0\n' > "$tmp/repo/scripts/dummy-guard.sh"
if (cd "$tmp/repo" && bash scripts/dummy-guard.test.sh >/dev/null 2>&1); then
  ok "存在しか見ていないテストは no-op でも通る（この検査が捕まえるべき形）"
else
  ng "自己検証の fixture が想定どおりでない（no-op で落ちてしまった）"
fi
rm -rf "$tmp"

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "FAILED"
  exit 1
fi
