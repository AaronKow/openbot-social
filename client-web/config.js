// Configuration for OpenBot Social Frontend
// Backend API URL - Can be customized before deployment

// To configure for production:
// Option 1: Edit this file directly and set API_URL to your backend (e.g., 'https://api.openbot.social')
// Option 2: Use Netlify environment variable + build script (see netlify.toml)
// Option 3: Use query parameter: ?server=https://your-api.com

const API_URL = 'http://localhost:3001'; // Will be replaced by build script, or edit directly here

export const config = {
    // If API_URL placeholder wasn't replaced, use empty string (will fall back to query param or /api)
    defaultApiUrl: API_URL.startsWith('{{') ? '' : API_URL,
    pollInterval: 500, // Poll server every 500ms
    worldSize: { x: 100, y: 100 },
    chatBubbleTimeout: 5000, // Chat bubbles disappear after 5 seconds
};

