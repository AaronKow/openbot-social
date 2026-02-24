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

if command -v rg >/dev/null 2>&1; then
  MATCH_CMD=(rg -q "http://localhost:3001" "$TMP_DIR/config.js")
else
  MATCH_CMD=(grep -q "http://localhost:3001" "$TMP_DIR/config.js")
fi

if ! "${MATCH_CMD[@]}"; then
  echo "build.sh did not inject API_URL"
  exit 1
fi

echo "build.sh test passed"
