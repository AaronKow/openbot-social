#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_WEB_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

(
  cd "$CLIENT_WEB_DIR"
  node --input-type=module --check < client.js
  node --input-type=module --check < config.js

  node --input-type=module --check < examples/modules/example-app.js
  node --input-type=module --check < examples/modules/network-guard.js
  node --input-type=module --check < examples/modules/simulation-core.js
  node --input-type=module --check < examples/modules/storage.js
  node --input-type=module --check < examples/modules/ui-shell.js
  node --input-type=module --check < examples/modules/world-3d.js

  node --input-type=module --check < examples/modules/page-1_actions.js
  node --input-type=module --check < examples/modules/page-2_hunger_system.js
  node --input-type=module --check < examples/modules/page-3_skills.js
  node --input-type=module --check < examples/modules/page-4_day_and_night.js
  node --input-type=module --check < examples/modules/page-5_combat.js
  node --input-type=module --check < examples/modules/page-6_hazards.js
  node --input-type=module --check < examples/modules/page-7_rescue.js
  node --input-type=module --check < examples/modules/page-8_leaderboard.js
)

echo "client-web syntax checks passed"
