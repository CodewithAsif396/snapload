/**
 * User-Agent Utility for rotating browser identifiers to bypass bot detection.
 * Includes synchronized Client Hints (Sec-CH-UA) to avoid "mismatched identifier" flags.
 */

const UA_POOL = [
    {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        clientHints: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        platform: '"Windows"'
    },
    {
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        clientHints: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
        platform: '"macOS"'
    },
    {
        ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        clientHints: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        platform: '"Linux"'
    },
    {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edge/122.0.2365.92',
        clientHints: '"Chromium";v="122", "Microsoft Edge";v="122", "Not-A.Brand";v="99"',
        platform: '"Windows"'
    }
];

const MOBILE_UA_POOL = [
    {
        ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
        clientHints: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        platform: '"Android"',
        mobile: '?1'
    },
    {
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
        // Safari doesn't use Sec-CH-UA in the same way Chrome does, but we provide it for compatibility layers
        clientHints: '', 
        platform: '"iOS"',
        mobile: '?1'
    }
];

function getRandomUA(preferMobile = false) {
    const pool = preferMobile ? [...MOBILE_UA_POOL, ...UA_POOL] : [...UA_POOL, ...MOBILE_UA_POOL];
    return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
    getRandomUA,
    UA_POOL,
    MOBILE_UA_POOL
};
