const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NYIBot/1.0)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Fetched ${url} -> status ${res.statusCode}, bytes ${data.length}`);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', (e) => {
      console.error(`Fetch error for ${url}:`, e.message);
      reject(e);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify({
    path: event.path,
    method: event.httpMethod,
    params: event.queryStringParameters
  }));

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const type = params.type || event.path.split('/').pop() || 'unknown';
  console.log('Resolved type:', type);

  try {
    if (type === 'standings') {
      const r = await fetchUrl('https://api-web.nhle.com/v1/standings/now');
      return { statusCode: 200, headers: CORS, body: r.body };
    }
    if (type === 'scores') {
      const r = await fetchUrl('https://api-web.nhle.com/v1/score/now');
      return { statusCode: 200, headers: CORS, body: r.body };
    }
    // Default test response
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, type, message: 'Function is running' })
    };
  } catch (e) {
    console.error('Handler error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message, type })
    };
  }
};
