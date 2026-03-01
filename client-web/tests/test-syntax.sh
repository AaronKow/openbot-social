#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_WEB_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

(
  cd "$CLIENT_WEB_DIR"
  node --input-type=module --check < client.js
  node --input-type=module --check < config.js
)

echo "client-web syntax checks passed"
