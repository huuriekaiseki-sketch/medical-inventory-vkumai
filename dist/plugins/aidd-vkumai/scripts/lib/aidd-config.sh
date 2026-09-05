#!/usr/bin/env bash
# aidd.config.json（導入先アダプター設定、issue #420 v1 セット B）を hook から読むための共通関数。
#
# なぜ: TRI/RISK の語彙・読み取り専用ロール名・検査コマンド・追記先ドキュメントは、これまで各 hook
# スクリプトに直書きされていた（ドメイン語・DB クライアントのパス・パッケージマネージャ名）。共通プラグインとして配るには、
# スクリプト本体から固有値を抜き、リポジトリ直下の aidd.config.json から読む必要がある。
# 判定エンジン側（router-risk.js の resolveRiskConfig）と同じく「既定値に足すだけで消せない」
# 方針は、各 hook が既定値を自分で持ち、ここから読んだ値を足す形で守る。
#
# 使い方:
#   source "$SCRIPT_DIR/lib/aidd-config.sh"
#   ROLES="$(aidd_config_query '.readonlyAgentTypes // [] | join(" ")' '')"
#
# 探索順（最初に見つかったファイルを使う）:
#   1. 環境変数 AIDD_CONFIG_FILE（テスト・手動検証での明示的な差し替え）
#   2. 引数で渡されたルート（hook 入力の cwd から解決したリポジトリルート）直下
#   3. この lib を持つリポジトリ（git rev-parse --show-toplevel）直下
#   4. この lib のレイアウト（scripts/lib/ の 2 つ上）直下
# fail-open: ファイルが無い・jq が無い・JSON が壊れている → 既定値（第2引数）を返す。
# hook はいずれも warning-only / deny の判定材料として使うだけなので、読めないときに落とすより
# 「固有語が足されない」に倒す（既定値は各 hook が持つので判定は緩まない）。

aidd_config_file() {
  local root_hint="${1:-}"
  if [[ -n "${AIDD_CONFIG_FILE:-}" ]]; then
    echo "$AIDD_CONFIG_FILE"
    return 0
  fi
  if [[ -n "$root_hint" && -f "$root_hint/aidd.config.json" ]]; then
    echo "$root_hint/aidd.config.json"
    return 0
  fi
  local lib_dir own_root layout_root
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  own_root="$(git -C "$lib_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$own_root" && -f "$own_root/aidd.config.json" ]]; then
    echo "$own_root/aidd.config.json"
    return 0
  fi
  # 4. レイアウト固定の最終手段（scripts/lib/ の 2 つ上）。git が使えない・PATH 上の git が
  #    テスト用フェイクに差し替えられている（check-domain-decisions-suggest.test.sh）場合の逃げ道
  layout_root="$(cd "$lib_dir/../.." 2>/dev/null && pwd || true)"
  if [[ -n "$layout_root" && -f "$layout_root/aidd.config.json" ]]; then
    echo "$layout_root/aidd.config.json"
    return 0
  fi
  echo ""
}

# $1=jq フィルタ（-r で評価）、$2=既定値、$3=ルートのヒント（省略可）
aidd_config_query() {
  local filter="$1" default="${2:-}" root_hint="${3:-}"
  local file
  file="$(aidd_config_file "$root_hint")"
  if [[ -z "$file" || ! -f "$file" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s' "$default"
    return 0
  fi
  local out
  if out="$(jq -r "$filter" "$file" 2>/dev/null)" && [[ -n "$out" && "$out" != "null" ]]; then
    printf '%s' "$out"
  else
    printf '%s' "$default"
  fi
}
