const https = require('https');
const http  = require('http');

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      // Follow redirects (301, 302, 307, 308)
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        const location = res.headers.location;
        const nextUrl = location.startsWith('http') ? location : new URL(location, url).href;
        res.resume(); // drain
        return fetchUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'test';

  if (type === 'test') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  const urls = {
    standings: 'https://api-web.nhle.com/v1/standings/now',
    scores:    'https://api-web.nhle.com/v1/score/now'
  };

  const url = urls[type];
  if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown type' }) };

  try {
    const r = await fetchUrl(url);
    return { statusCode: 200, headers: CORS, body: r.body };
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
