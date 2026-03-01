#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_WEB_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
cp "$CLIENT_WEB_DIR/configure-api.sh" "$TMP_DIR/"
cat > "$TMP_DIR/config.js" <<'JS'
window.OPENBOT_CONFIG = {
  API_URL: '{{API_URL}}'
};
JS

(
  cd "$TMP_DIR"
  bash configure-api.sh >/tmp/configure-api.out
)

if command -v rg >/dev/null 2>&1; then
  MATCH_CMD=(rg -q "https://api.openbot.social" "$TMP_DIR/config.js")
else
  MATCH_CMD=(grep -q "https://api.openbot.social" "$TMP_DIR/config.js")
fi

if ! "${MATCH_CMD[@]}"; then
  echo "configure-api.sh did not replace API placeholder"
  exit 1
fi

if [ -f "$TMP_DIR/config.js.bak" ]; then
  echo "configure-api.sh should remove backup file"
  exit 1
fi

echo "configure-api.sh test passed"
