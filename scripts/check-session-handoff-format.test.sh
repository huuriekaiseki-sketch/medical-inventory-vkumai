#!/usr/bin/env bash
# WHY(2026-09-11): 引き継ぎメモは PR 本文・セッション終了報告・`docs/sessions/` のどれで
#      残してもよい規約だが、**機械で見ていたのは PR 本文だけ**だった
#      （`scripts/check-handoff-format.sh` に「セッション終了報告と docs/sessions/ 経由は
#      検知対象外」と明記されたまま、`undetectable-rules-inventory.md` に 1 行として残っていた）。
#      ファイルはリポジトリに入るのだから、**PR 本文より検査しやすい**。
#
#      判定（必須見出し・04 表の 4 値・理由の有無）は `scripts/lib/handoff-04-table.sh` に
#      置いて hook と共用する。複製すると片方だけ古くなる（今日 5 回踏んだ C-047）。
#
# 対象を日付で切る理由: 00〜05 の証拠パッケージ形式は 2026-08-27 に入った（#671）。
#      それ以前のメモは当時の規約どおりで、**後から違反にするのは歴史の書き換え**になる。
#      ファイル名の日付（`YYYY-MM-DD-*.md`）で切り、境界の値は下の SINCE に書く。
#
#   (a) 対象のメモに必須見出し（30秒サマリー / どう確認したか）がある
#   (b) 04 表の状態が 4 値で、➖ / ⬜ には理由がある
#   (c) 走査が壊れていない（`docs/sessions/` を読めなければ落とす。C-044）
#   (d) fixture で (a)(b) を検知でき、正しいメモを誤検知しない（RED 方向。C-022）
#
# 限界:
#   - **セッション終了報告（会話の中だけで終わるもの）は依然として見えない。**
#     ファイルに残らないものは機械で追えない。ここで塞げるのは `docs/sessions/` だけ。
#   - 見出しは部分文字列で見る近似（hook 側と同じ緩さに揃えてある）。
#   - 中身が正しいかは見ない（「✅ 実施」と書いてあるが実際は回していない、は分からない）。
#
# 実行: bash scripts/check-session-handoff-format.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=lib/handoff-04-table.sh
source "$SCRIPT_DIR/lib/handoff-04-table.sh"

# この日以降のファイル名を持つメモだけを見る（00〜05 形式が入った翌日）
SINCE="${SESSION_HANDOFF_SINCE:-2026-08-28}"
SESSIONS_DIR="${SESSION_HANDOFF_DIR:-$REPO_ROOT/docs/sessions}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=メモのファイル → 違反を 1 行ずつ出す（無ければ何も出さない）
check_note() {
  local file="$1" name body issues
  name="$(basename "$file")"
  body="$(cat "$file")"

  if ! grep -qF '30秒サマリー' <<<"$body"; then
    echo "    ${name}: 必須見出し「30秒サマリー」が無い"
  fi
  if ! grep -qF 'どう確認したか' <<<"$body"; then
    echo "    ${name}: 必須見出し「どう確認したか」が無い"
    return
  fi
  issues="$(handoff_four_state_issues "$body")"
  [ -n "$issues" ] && echo "    ${name}: 04 表が 4 値に収まっていない: ${issues}"
  return 0
}

# $1=対象ディレクトリ → 対象のファイルを列挙する
target_notes() {
  local dir="$1" f name date
  [ -d "$dir" ] || return 0
  for f in "$dir"/*.md; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    date="${name:0:10}"
    # 日付で始まらないファイル（README 等）は対象外
    grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' <<<"$date" || continue
    # 文字列比較で日付の前後が決まる形式なので `>` でよい
    [[ "$date" < "$SINCE" ]] && continue
    printf '%s\n' "$f"
  done
}

echo "=== scenario 1: 走査が壊れていない（C-044） ==="
if [ -d "$SESSIONS_DIR" ]; then
  ALL_COUNT="$(ls -1 "$SESSIONS_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$ALL_COUNT" -ge 1 ]; then
    assert_ok "${SESSIONS_DIR#"$REPO_ROOT"/} を読めている（メモ ${ALL_COUNT} 本）"
  else
    assert_fail "メモが 1 本も読めない（走査が壊れている疑い）"
  fi
else
  # 導入先によっては `docs/sessions/` を持たない。無いこと自体は違反にしない
  assert_ok "この導入先は ${SESSIONS_DIR#"$REPO_ROOT"/} を持たない（対象 0 件）"
fi

echo "=== scenario 2: ${SINCE} 以降のメモが引き継ぎフォーマットに収まっている ==="
TARGETS="$(target_notes "$SESSIONS_DIR")"
TARGET_COUNT=0
[ -n "$TARGETS" ] && TARGET_COUNT="$(wc -l <<<"$TARGETS" | tr -d ' ')"
VIOLATIONS=""
if [ -n "$TARGETS" ]; then
  while IFS= read -r f; do
    VIOLATIONS="$VIOLATIONS$(check_note "$f")"$'\n'
  done <<<"$TARGETS"
fi
VIOLATIONS="$(grep -v '^$' <<<"$VIOLATIONS" || true)"
if [ -z "$VIOLATIONS" ] && [ "$TARGET_COUNT" -eq 0 ]; then
  # 実データに対しては**まだ一度も効いていない**。そう書く（「違反なし」と読ませない）。
  # 効くことは scenario 3 の fixture で測る
  assert_ok "${SINCE} 以降のメモはまだ 1 本も無い（実データに対する判定は未発動。全 ${ALL_COUNT:-0} 本はそれ以前）"
elif [ -z "$VIOLATIONS" ]; then
  assert_ok "対象 ${TARGET_COUNT} 本に違反なし（${SINCE} より前の ${ALL_COUNT:-0} 本中の残りは当時の規約のまま）"
else
  assert_fail "引き継ぎフォーマットから外れたメモがある" "$VIOLATIONS
      直し方: .claude/skills/handoff-format/SKILL.md の形に揃える
      （04 表は bash scripts/derive-test-selection.sh origin/main --format table の出力を貼る）"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sessions"

cat > "$WORK/sessions/2026-09-10-no-headings.md" <<'EOF'
# なんとなくの記録

できました。
EOF
cat > "$WORK/sessions/2026-09-10-bad-table.md" <<'EOF'
## 30秒サマリー
- 変更概要: なにか

## 04 どう確認したか
| 種別 | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 | たぶん通った | — |
| hook 回帰 | ➖ |  |
| unit | ✅ 実施（自動テスト: パス） | 2220/2220 |
EOF
cat > "$WORK/sessions/2026-09-10-good.md" <<'EOF'
## 30秒サマリー
- 変更概要: なにか

## 04 どう確認したか
| 種別 | 状態 | 結果・証跡 |
| --- | --- | --- |
| 型検査 | ✅ 実施（自動テスト: パス） | tsc 通過 |
| hook 回帰 | ➖ 今回不要 | hook を触っていない |
| E2E | ⬜ 未実施 | 認証状態の生成に実 DB が要るため |
EOF
cat > "$WORK/sessions/2026-08-01-old.md" <<'EOF'
# 古いメモ（境界より前なので対象外）
EOF
cat > "$WORK/sessions/README.md" <<'EOF'
日付で始まらないので対象外
EOF

FX_TARGETS="$(target_notes "$WORK/sessions")"
FX_OUT=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  FX_OUT="$FX_OUT$(check_note "$f")"$'\n'
done <<<"$FX_TARGETS"

if grep -q '2026-09-10-no-headings.md: 必須見出し「30秒サマリー」が無い' <<<"$FX_OUT"; then
  assert_ok "見出しの欠落を検知"
else
  assert_fail "見出しの欠落を検知できない" "$FX_OUT"
fi
if grep -q '2026-09-10-bad-table.md.*4 値に収まっていない' <<<"$FX_OUT"; then
  assert_ok "4 値から外れた状態を検知"
else
  assert_fail "4 値から外れた状態を検知できない" "$FX_OUT"
fi
if grep -q '2026-09-10-bad-table.md.*hook 回帰（➖ なのに理由が無い）' <<<"$FX_OUT"; then
  assert_ok "理由の無い ➖ を名指しする"
else
  assert_fail "理由の無い ➖ を検知できない" "$FX_OUT"
fi
if grep -q '2026-09-10-good.md' <<<"$FX_OUT"; then
  assert_fail "正しいメモを誤検知した" "$FX_OUT"
else
  assert_ok "正しいメモは誤検知しない"
fi
if grep -q '2026-08-01-old.md' <<<"$FX_TARGETS"; then
  assert_fail "境界より前のメモを対象にしている" "$FX_TARGETS"
else
  assert_ok "境界（${SINCE}）より前のメモは対象外"
fi
if grep -q 'README.md' <<<"$FX_TARGETS"; then
  assert_fail "日付で始まらないファイルを対象にしている" "$FX_TARGETS"
else
  assert_ok "日付で始まらないファイルは対象外"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
