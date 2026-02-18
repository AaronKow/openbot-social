#!/bin/bash
# Quick configuration script to set API URL to api.openbot.social
# Run this before deploying to hardcode your API URL

echo "Configuring OpenBot Social Frontend..."
echo "Setting API URL to: https://api.openbot.social"

# Replace the placeholder in config.js
sed -i.bak "s|{{API_URL}}|https://api.openbot.social|g" config.js

# Remove backup file
rm -f config.js.bak

echo "✅ Configuration complete!"
echo ""
echo "Your frontend is now configured to use: https://api.openbot.social"
echo ""
echo "Next steps:"
echo "  1. Deploy to Netlify: netlify deploy --prod"
echo "  2. Or commit and push to trigger auto-deployment"
echo ""
echo "To reset: git checkout config.js"
