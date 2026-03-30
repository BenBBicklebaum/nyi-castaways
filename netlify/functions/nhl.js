const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, ok: true }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: '', ok: false, error: 'timeout' }); });
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'test';

  if (type === 'test') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, message: 'Function running' }) };
  }

  const urls = {
    standings: 'https://api-web.nhle.com/v1/standings/now',
    scores:    'https://api-web.nhle.com/v1/score/now'
  };

  const url = urls[type];
  if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown type: ' + type }) };

  const result = await fetchUrl(url);

  if (!result.ok || result.status !== 200) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        error: result.error || 'Fetch failed',
        status: result.status,
        url,
        type
      })
    };
  }

  // Return raw NHL API response
  return { statusCode: 200, headers: CORS, body: result.body };
};
