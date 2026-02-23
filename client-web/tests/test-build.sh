#!/usr/bin/env bash
set -euo pipefail

TMP_DIR=$(mktemp -d)
cp ./build.sh "$TMP_DIR/"
cat > "$TMP_DIR/config.js" <<'JS'
window.OPENBOT_CONFIG = {
  API_URL: '{{API_URL}}'
};
JS

(
  cd "$TMP_DIR"
  API_URL="http://localhost:3001" bash build.sh >/tmp/build.out
)

if ! rg -q "http://localhost:3001" "$TMP_DIR/config.js"; then
  echo "build.sh did not inject API_URL"
  exit 1
fi

echo "build.sh test passed"
