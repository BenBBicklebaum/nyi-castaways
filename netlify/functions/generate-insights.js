// Scheduled function — runs hourly, generates AI insights after race group games finish
// Stores result in Netlify Blobs for fast page-load retrieval

const https = require('https');
const { getStore } = require('@netlify/blobs');

// ── Fetch helpers ────────────────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('http');
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...opts }
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Race group ───────────────────────────────────────────────────
const RACE_GROUP = new Set(['BOS','CBJ','DET','NYI','OTT','PHI','PIT']);

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('generate-insights: starting', new Date().toISOString());

  try {
    // 1. Fetch current standings
    const stRes = await fetchUrl('https://api-web.nhle.com/v1/standings/now');
    if (stRes.status !== 200) throw new Error('Standings fetch failed: ' + stRes.status);
    const stData = JSON.parse(stRes.body);

    // 2. Build standings map for race group
    const ST = {};
    (stData.standings || []).forEach(row => {
      const abbrev = (row.teamAbbrev && typeof row.teamAbbrev === 'object')
        ? row.teamAbbrev.default : row.teamAbbrev;
      if (!abbrev || !RACE_GROUP.has(abbrev)) return;
      ST[abbrev] = {
        pts:    row.points || 0,
        gp:     row.gamesPlayed || 0,
        wins:   row.wins || 0,
        losses: row.losses || 0,
        otl:    row.otLosses || 0,
        rw:     row.regulationWins || 0,
        row:    row.regulationPlusOtWins || 0,
        diff:   row.goalDifferential || 0,
        l10w:   row.l10Wins || 0,
        l10l:   row.l10Losses || 0,
        l10otl: row.l10OtLosses || 0,
        streak: row.streakCode || '',
        conf:   row.conferenceAbbrev || '',
        div:    row.divisionAbbrev || ''
      };
    });

    if (!ST['NYI']) throw new Error('NYI not found in standings');

    // 3. Fetch today's scores to check if race group games finished recently
    const scRes = await fetchUrl('https://api-web.nhle.com/v1/score/now');
    let recentResults = [];
    if (scRes.status === 200) {
      const scData = JSON.parse(scRes.body);
      (scData.games || []).forEach(g => {
        const away = g.awayTeam?.abbrev, home = g.homeTeam?.abbrev;
        const state = g.gameState;
        if ((RACE_GROUP.has(away) || RACE_GROUP.has(home)) &&
            (state === 'OFF' || state === 'FINAL')) {
          recentResults.push(
            `${away} ${g.awayTeam?.score||0} - ${g.homeTeam?.score||0} ${home} (Final)`
          );
        }
      });
    }

    // 4. Check blob for last update time — skip if updated in last 55 min and no new games
    const store = getStore('insights-cache');
    let lastMeta = null;
    try {
      const existing = await store.getWithMetadata('nyi-insights');
      if (existing && existing.metadata) {
        lastMeta = existing.metadata;
        const lastUpdate = new Date(lastMeta.updatedAt || 0);
        const minutesSince = (Date.now() - lastUpdate.getTime()) / 60000;
        if (minutesSince < 55 && recentResults.length === 0) {
          console.log('Skipping — no new games and updated', Math.round(minutesSince), 'min ago');
          return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
        }
      }
    } catch(e) { /* no existing blob, proceed */ }

    // 5. Build context for GPT
    const nyi = ST['NYI'];
    const nyiGl = 82 - nyi.gp;
    const nyiPace = nyi.pts / nyi.gp;
    const nyiProj = Math.round(nyi.pts + nyiPace * nyiGl);

    // Sort race group by pts
    const sorted = Object.entries(ST)
      .sort((a,b) => b[1].pts - a[1].pts);

    const standingsStr = sorted.map(([t, s]) => {
      const gp = s.wins + s.losses + s.otl;
      const gl = 82 - gp;
      const proj = Math.round(s.pts + (s.pts/gp) * gl);
      const l10 = `${s.l10w}-${s.l10l}-${s.l10otl}`;
      return `${t}: ${s.pts}pts (${s.wins}W-${s.losses}L-${s.otl}OTL, ${gp}GP, ${gl}left) | RW:${s.rw} ROW:${s.row} DIFF:${s.diff>0?'+':''}${s.diff} L10:${l10} Streak:${s.streak} | Proj:${proj}pts`;
    }).join('\n');

    // Tiebreaker context
    const tbLines = [];
    sorted.forEach(([t, s]) => {
      if (t === 'NYI') return;
      if (Math.abs(nyi.pts - s.pts) <= 3) {
        const rwEdge = nyi.rw > s.rw ? 'NYI leads RW' : nyi.rw < s.rw ? `${t} leads RW` : 'RW tied';
        tbLines.push(`NYI vs ${t}: ${nyi.pts-s.pts>0?'+'+(nyi.pts-s.pts):nyi.pts-s.pts}pts gap | ${rwEdge} (${nyi.rw} vs ${s.rw})`);
      }
    });

    const recentStr = recentResults.length
      ? `\nRecent results:\n${recentResults.join('\n')}`
      : '';

    const prompt = `You are Butchie, the AI analyst for the NYI Castaways Playoff Race Hub. You're a sharp, knowledgeable hockey analyst — think of a beat writer who really knows the stats. You're a die-hard Islanders fan but you're honest about what the numbers say.

Current race group standings (Eastern Conference playoff bubble):
${standingsStr}

Tiebreaker situations (within 3pts of NYI):
${tbLines.length ? tbLines.join('\n') : 'No close tiebreaker situations currently'}
${recentStr}

NYI has ${nyiGl} games remaining. Season ends April 16.

Write 3-4 sharp, distinct analytical insights about where the Islanders stand in the playoff race. Each insight should:
- Uncover something non-obvious that requires synthesizing multiple data points
- Be specific — reference actual numbers, team names, trends
- Sound like a knowledgeable analyst, not a stats printout
- Be honest — if NYI is in trouble, say so; if they're in good shape, explain why
- Be 2-3 sentences max each

Format as a JSON array of strings, each string being one insight. No preamble, just the JSON array.
Example format: ["insight 1", "insight 2", "insight 3"]`;

    // 6. Call OpenAI
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const aiRes = await postJson(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }]
      },
      { 'Authorization': 'Bearer ' + apiKey }
    );

    if (aiRes.status !== 200) throw new Error('OpenAI error: ' + aiRes.status + ' ' + aiRes.body);

    const aiData = JSON.parse(aiRes.body);
    const content = aiData.choices?.[0]?.message?.content || '';

    // Parse JSON array from response
    let insights = [];
    try {
      const cleaned = content.replace(/```json|```/g, '').trim();
      insights = JSON.parse(cleaned);
      if (!Array.isArray(insights)) throw new Error('Not an array');
    } catch(e) {
      // Fallback: split on newlines if JSON parse fails
      insights = content.split('\n').filter(l => l.trim().length > 20);
    }

    // 7. Store in Netlify Blobs
    const payload = {
      insights,
      generatedAt: new Date().toISOString(),
      recentGames: recentResults,
      nyiPts: nyi.pts,
      nyiGp: nyi.gp
    };

    await store.setJSON('nyi-insights', payload, {
      metadata: { updatedAt: new Date().toISOString() }
    });

    console.log('generate-insights: stored', insights.length, 'insights');
    return { statusCode: 200, body: JSON.stringify({ ok: true, count: insights.length }) };

  } catch(e) {
    console.error('generate-insights error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
