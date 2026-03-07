#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_WEB_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
EXAMPLES_DIR="$CLIENT_WEB_DIR/examples"

required_files=(
  "index.html"
  "1_actions.html"
  "2_hunger_system.html"
  "3_skills.html"
  "4_day_and_night.html"
  "5_combat.html"
  "6_hazards.html"
  "7_rescue.html"
  "8_leaderboard.html"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$EXAMPLES_DIR/$file" ]]; then
    echo "Missing required example file: $file"
    exit 1
  fi
done

if command -v rg >/dev/null 2>&1; then
  if rg -n "localhost:3001|api\.openbot\.social|(^|[^a-zA-Z0-9_])/api([^a-zA-Z0-9_]|$)|postgres|mongodb|database" \
    "$EXAMPLES_DIR" \
    --glob '!**/network-guard.js'; then
    echo "Forbidden endpoint reference found in examples"
    exit 1
  fi
else
  echo "ripgrep not available; skipping forbidden endpoint scan"
fi

echo "examples sequence and offline endpoint checks passed"
