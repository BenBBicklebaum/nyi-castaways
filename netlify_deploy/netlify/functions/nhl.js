// Netlify serverless function — proxies NHL API + Anthropic API
// No CORS issues since this runs server-side

const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function callAnthropic(prompt) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/nhl', '');

  try {
    // ── Standings ──────────────────────────────────────────────────
    if (path === '/standings' || path === '' && event.queryStringParameters?.type === 'standings') {
      const result = await fetchUrl('https://api-web.nhle.com/v1/standings/now');
      return { statusCode: result.status, headers: CORS, body: result.body };
    }

    // ── Scores ─────────────────────────────────────────────────────
    if (path === '/scores') {
      const result = await fetchUrl('https://api-web.nhle.com/v1/score/now');
      return { statusCode: result.status, headers: CORS, body: result.body };
    }

    // ── AI Insights ─────────────────────────────────────────────────
    if (path === '/insights' && event.httpMethod === 'POST') {
      const { prompt } = JSON.parse(event.body || '{}');
      if (!prompt) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No prompt' }) };
      const result = await callAnthropic(prompt);
      return { statusCode: result.status, headers: CORS, body: result.body };
    }

    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Unknown endpoint' }) };

  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
