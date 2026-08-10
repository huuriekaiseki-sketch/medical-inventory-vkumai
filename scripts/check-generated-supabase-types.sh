#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
GENERATED="$ROOT/src/types/database.generated.ts"
TMP="$(mktemp)"
NORMALIZED="$(mktemp)"
trap 'rm -f "$TMP" "$NORMALIZED"' EXIT

supabase gen types typescript --local > "$TMP"
# CLIの末尾空行だけはバージョン差で変わり得るため、末尾空行を除いて比較する。
awk 'NF {last=NR} {lines[NR]=$0} END {for (i=1; i<=last; i++) print lines[i]}' "$TMP" > "$NORMALIZED"
awk 'NF {last=NR} {lines[NR]=$0} END {for (i=1; i<=last; i++) print lines[i]}' "$GENERATED" | cmp -s - "$NORMALIZED" || {
  echo "generated Supabase types are stale; run supabase gen types typescript --local" >&2
  exit 1
}
echo "generated Supabase types are up to date"
