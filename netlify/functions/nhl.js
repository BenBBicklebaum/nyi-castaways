const https = require('https');
const http  = require('http');

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        const location = res.headers.location;
        const nextUrl = location.startsWith('http') ? location : new URL(location, url).href;
        res.resume();
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
  const params = event.queryStringParameters || {};
  const type = params.type || 'test';

  if (type === 'test') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  // ── Cached AI insights from Netlify Blobs ──────────────────────
  if (type === 'insights') {
    try {
      const { getStore } = require('@netlify/blobs');
      const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
      const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
      const storeOpts = siteID ? { name: 'insights-cache', siteID, token } : 'insights-cache';
      const store = getStore(storeOpts);
      const raw = await store.get('nyi-insights');
      if (!raw) return { statusCode: 200, headers: CORS, body: JSON.stringify({ insights: [], generatedAt: null }) };
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ insights: [], generatedAt: null, error: e.message }) };
    }
  }

  // ── Standings ──────────────────────────────────────────────────
  if (type === 'standings') {
    try {
      const r = await fetchUrl('https://api-web.nhle.com/v1/standings/now');
      return { statusCode: 200, headers: CORS, body: r.body };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── Scores (with optional date) ────────────────────────────────
  if (type === 'scores') {
    try {
      const url = params.date
        ? 'https://api-web.nhle.com/v1/score/' + params.date
        : 'https://api-web.nhle.com/v1/score/now';
      const r = await fetchUrl(url);
      return { statusCode: 200, headers: CORS, body: r.body };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── MoneyPuck simulation odds for NYI ─────────────────────────
  if (type === 'moneypuck') {
    try {
      const r = await fetchUrl('https://moneypuck.com/moneypuck/simulations/simulations_recent.csv');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      // Parse CSV — find the ALL,NYI row
      const lines = r.body.split('\n');
      const header = lines[0].split(',');
      let nyiRow = null;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols[0] === 'ALL' && cols[1] === 'NYI') { nyiRow = cols; break; }
      }
      if (!nyiRow) throw new Error('NYI row not found');
      const get = (col) => {
        const idx = header.indexOf(col);
        return idx >= 0 ? parseFloat(nyiRow[idx]) : null;
      };
      const result = {
        madePlayoffs:      get('madePlayoffs'),
        wildcard1:         get('wildcard1Odds'),
        wildcard2:         get('wildcard2Odds'),
        divisionPlace2:    get('divisionPlace2Odds'),
        divisionPlace3:    get('divisionPlace3Odds'),
        fetchedAt:         new Date().toISOString()
      };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── Islanders News Feed (Google News RSS) ─────────────────────
  if (type === 'news') {
    try {
      const query = encodeURIComponent('New York Islanders NHL');
      const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
      const r = await fetchUrl(rssUrl);
      if (r.status !== 200) throw new Error('HTTP ' + r.status);

      // Parse RSS XML — extract up to 10 items
      const xml = r.body;
      const items = [];
      const itemRx = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRx.exec(xml)) !== null && items.length < 10) {
        const block = m[1];
        const get = (tag) => {
          const rx = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
          const r = rx.exec(block);
          return r ? r[1].trim() : '';
        };
        const title   = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
        const link    = get('link');
        const pubDate = get('pubDate');
        const source  = get('source') || (block.match(/<source[^>]*>([^<]+)<\/source>/)?.[1] || '');
        if (title && link) items.push({ title, link, pubDate, source });
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ items, fetchedAt: new Date().toISOString() }) };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ items: [], error: e.message }) };
    }
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown type: ' + type }) };
};
