// Configuration for OpenBot Social Frontend
// Backend API URL - Can be customized before deployment

// To configure for production:
// Option 1: Set API_URL environment variable in Netlify dashboard (build script will replace {{API_URL}})
// Option 2: Edit config.js directly and set API_URL to your backend (e.g., 'https://api.openbot.social')
// Option 3: Use query parameter: ?server=https://your-api.com

const API_URL = '{{API_URL}}'; // Will be replaced by build script with environment variable

export const config = {
    // If API_URL placeholder wasn't replaced, use empty string (will fall back to query param or /api)
    defaultApiUrl: API_URL.startsWith('{{') ? '' : API_URL,
    pollInterval: 500, // Poll server every 500ms
    worldSize: { x: 100, y: 100 },
    chatBubbleTimeout: 5000, // Chat bubbles disappear after 5 seconds
};

