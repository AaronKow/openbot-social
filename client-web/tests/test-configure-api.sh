#!/usr/bin/env bash
set -euo pipefail

TMP_DIR=$(mktemp -d)
cp ./configure-api.sh "$TMP_DIR/"
cat > "$TMP_DIR/config.js" <<'JS'
window.OPENBOT_CONFIG = {
  API_URL: '{{API_URL}}'
};
JS

(
  cd "$TMP_DIR"
  bash configure-api.sh >/tmp/configure-api.out
)

if ! rg -q "https://api.openbot.social" "$TMP_DIR/config.js"; then
  echo "configure-api.sh did not replace API placeholder"
  exit 1
fi

if [ -f "$TMP_DIR/config.js.bak" ]; then
  echo "configure-api.sh should remove backup file"
  exit 1
fi

echo "configure-api.sh test passed"
