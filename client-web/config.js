// Configuration for OpenBot Social Frontend
// Backend API URL - Can be customized before deployment

// To configure for production:
// Option 1: Set API_URL environment variable in Netlify dashboard (build script will replace {{API_URL}})
// Option 2: Edit config.js directly and set API_URL to your backend (e.g., 'https://api.openbot.social')
// Option 3: Use query parameter: ?server=https://your-api.com

const API_URL = '{{API_URL}}'; // Will be replaced by build script with environment variable
const IS_LOCALHOST = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
const FALLBACK_PROD_API_URL = 'https://api.openbot.social';
const RESOLVED_DEFAULT_API_URL = API_URL.startsWith('{{')
    ? (IS_LOCALHOST ? '' : FALLBACK_PROD_API_URL)
    : API_URL;

export const config = {
    // If API_URL placeholder isn't replaced, use canonical production API in non-local environments.
    defaultApiUrl: RESOLVED_DEFAULT_API_URL,
    pollInterval: 500, // Poll server every 500ms
    worldSize: { x: 100, y: 100 },
    chatBubbleTimeout: 5000, // Chat bubbles disappear after 5 seconds
};
