#!/bin/bash
# Build script for Netlify deployment
# Substitutes environment variables into config.js

echo "Building OpenBot Social Frontend..."

# If API_URL environment variable is set, replace the placeholder in config.js
if [ -n "$API_URL" ]; then
    echo "Setting API_URL from environment: $API_URL"
    sed -i.bak "s|{{API_URL}}|$API_URL|g" config.js
    rm config.js.bak 2>/dev/null || true
else
    echo "No API_URL environment variable set. Using default configuration."
    echo "Set API_URL in Netlify environment variables or edit config.js manually."
fi

echo "Build complete!"
