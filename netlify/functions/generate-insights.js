const https = require('https');
const { getStore } = require('@netlify/blobs');

// ── Fetch helpers ─────────────────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : require('http');
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

// ── Constants ─────────────────────────────────────────────────────
const RACE_GROUP = new Set(['BOS','CBJ','DET','NYI','OTT','PHI','PIT']);

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async (event, context) => {
  console.log('generate-insights: starting', new Date().toISOString());
  // Netlify Blobs needs siteID — get from context or environment
  const siteID = (context && context.site && context.site.id) || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;
  const storeOpts = siteID ? { name: 'insights-cache', siteID, token } : 'insights-cache';
  const store = getStore(storeOpts);

  try {
    // 1. Fetch today's scores
    const scRes = await fetchUrl('https://api-web.nhle.com/v1/score/now');
    if (scRes.status !== 200) throw new Error('Scores fetch failed: ' + scRes.status);
    const scData = JSON.parse(scRes.body);

    // 2. Build current game state snapshot for push group games
    // Key: gameId, Value: { away, home, state, awayScore, homeScore }
    const currentSnapshot = {};
    const finishedGames = [];

    (scData.games || []).forEach(g => {
      const away = g.awayTeam?.abbrev, home = g.homeTeam?.abbrev;
      if (!RACE_GROUP.has(away) && !RACE_GROUP.has(home)) return;
      const gameId = String(g.id);
      const state = g.gameState;
      currentSnapshot[gameId] = {
        away, home, state,
        awayScore: g.awayTeam?.score || 0,
        homeScore: g.homeTeam?.score || 0
      };
      if (state === 'OFF' || state === 'FINAL') {
        finishedGames.push(`${away} ${g.awayTeam?.score||0} - ${g.homeTeam?.score||0} ${home}`);
      }
    });

    // 3. Load previous snapshot from Blobs
    let previousSnapshot = {};
    let insightsAge = Infinity;
    try {
      const prev = await store.getJSON('game-snapshot');
      if (prev) previousSnapshot = prev;
    } catch(e) { /* no previous snapshot */ }

    try {
      const existing = await store.getJSON('nyi-insights');
      if (existing?.generatedAt) {
        insightsAge = (Date.now() - new Date(existing.generatedAt).getTime()) / 60000;
      }
    } catch(e) { /* no existing insights */ }

    // 4. Detect games that newly transitioned to finished since last run
    // A meaningful trigger = a push group game flipped from non-final to final
    const newlyFinished = [];
    Object.entries(currentSnapshot).forEach(([gameId, curr]) => {
      const prev = previousSnapshot[gameId];
      const currFinal = curr.state === 'OFF' || curr.state === 'FINAL';
      const prevFinal = prev && (prev.state === 'OFF' || prev.state === 'FINAL');

      if (currFinal && !prevFinal) {
        // Game just finished since last run
        newlyFinished.push(`${curr.away} ${curr.awayScore} - ${curr.homeScore} ${curr.home}`);
        console.log('Newly finished:', gameId, curr.away, 'vs', curr.home);
      }
    });

    // 5. Save current snapshot for next run (always update this)
    await store.setJSON('game-snapshot', currentSnapshot);

    // 6. Decide whether to generate new insights
    const shouldGenerate =
      newlyFinished.length > 0 ||        // A push group game just finished
      insightsAge === Infinity ||          // No insights ever generated
      insightsAge > 24 * 60;              // Fallback: regenerate daily even if no games

    if (!shouldGenerate) {
      console.log(`Skipping — no newly finished games, insights ${Math.round(insightsAge)}min old`);
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'no new games', insightsAge: Math.round(insightsAge) }) };
    }

    console.log('Generating insights. Triggers:', newlyFinished.length ? newlyFinished.join(', ') : 'age/first-run');

    // 7. Fetch standings for full context
    const stRes = await fetchUrl('https://api-web.nhle.com/v1/standings/now');
    if (stRes.status !== 200) throw new Error('Standings fetch failed: ' + stRes.status);
    const stData = JSON.parse(stRes.body);

    const ST = {};
    (stData.standings || []).forEach(row => {
      const abbrev = (row.teamAbbrev && typeof row.teamAbbrev === 'object')
        ? row.teamAbbrev.default : row.teamAbbrev;
      if (!abbrev || !RACE_GROUP.has(abbrev)) return;
      ST[abbrev] = {
        pts: row.points||0, gp: row.gamesPlayed||0,
        wins: row.wins||0, losses: row.losses||0, otl: row.otLosses||0,
        rw: row.regulationWins||0, row: row.regulationPlusOtWins||0,
        diff: row.goalDifferential||0,
        l10w: row.l10Wins||0, l10l: row.l10Losses||0, l10otl: row.l10OtLosses||0,
        streak: row.streakCode||''
      };
    });

    if (!ST['NYI']) throw new Error('NYI not in standings');

    // 8. Build rich prompt context
    const nyi = ST['NYI'];
    const sorted = Object.entries(ST).sort((a,b) => b[1].pts - a[1].pts);

    const standingsStr = sorted.map(([t, s]) => {
      const gp = s.wins+s.losses+s.otl, gl = 82-gp;
      const proj = gp ? Math.round(s.pts + (s.pts/gp)*gl) : s.pts;
      const l10 = `${s.l10w}-${s.l10l}-${s.l10otl}`;
      const ptsPct = gp ? ((s.wins*2+s.otl)/(gp*2)).toFixed(3) : '.000';
      return `${t}: ${s.pts}pts | ${s.wins}-${s.losses}-${s.otl} (${gp}GP, ${gl}left) | RW:${s.rw} ROW:${s.row} DIFF:${s.diff>=0?'+':''}${s.diff} | L10:${l10} Streak:${s.streak} | Pts%:${ptsPct} Proj:${proj}pts`;
    }).join('\n');

    // Close tiebreaker situations
    const tbLines = sorted
      .filter(([t]) => t !== 'NYI' && Math.abs(nyi.pts - ST[t].pts) <= 3)
      .map(([t, s]) => {
        const gap = nyi.pts - s.pts;
        const rwEdge = nyi.rw > s.rw ? `NYI leads RW (${nyi.rw} vs ${s.rw})` :
                       nyi.rw < s.rw ? `${t} leads RW (${s.rw} vs ${nyi.rw})` :
                       `RW tied at ${nyi.rw}`;
        const rowEdge = nyi.row > s.row ? `NYI leads ROW` : nyi.row < s.row ? `${t} leads ROW` : `ROW tied`;
        return `NYI vs ${t}: ${gap >= 0 ? '+' : ''}${gap}pts | ${rwEdge} | ${rowEdge}`;
      });

    const recentStr = newlyFinished.length
      ? `\nGames that just finished:\n${newlyFinished.join('\n')}`
      : finishedGames.length
      ? `\nToday's completed push group games:\n${finishedGames.join('\n')}`
      : '\nNo push group games today.';

    // MTL/BOS context
    const mtlST = ST['MTL'], bosST = ST['BOS'];
    let mtlContext = '';
    if(mtlST && bosST && ST['NYI']) {
      const bosGl = 82-(bosST.wins+bosST.losses+bosST.otl);
      const bosMax = bosST.pts + bosGl*2;
      const atlSorted = ['BUF','TBL','MTL','BOS','OTT','DET','TOR','FLA']
        .filter(t=>ST[t]).sort((a,b)=>ST[b].pts-ST[a].pts);
      const mtlInWC = atlSorted.indexOf('MTL') >= 3;
      const mtlGap = mtlST.pts - ST['NYI'].pts;
      const metSorted = ['CAR','NYI','PIT','CBJ','PHI','WSH','NJD','NYR']
        .filter(t=>ST[t]).sort((a,b)=>ST[b].pts-ST[a].pts);
      const nyiMetRank = metSorted.indexOf('NYI')+1;
      if(mtlInWC) {
        mtlContext = `\nMTL ALERT: MTL has dropped out of ATL top-3 and is now in WC (${mtlST.pts}pts, ${Math.abs(mtlGap)}pts ${mtlGap>0?'ahead of':'behind'} NYI). Direct WC competitor. Root AGAINST MTL.`;
      } else if(bosMax >= mtlST.pts) {
        mtlContext = `\nMTL WATCH: MTL is ATL#3 (${mtlST.pts}pts, ${mtlGap}pts ahead of NYI). BOS (${bosST.pts}pts, ${bosGl}GL, max=${bosMax}) can still catch them. If BOS passes MTL, Montreal enters WC ${mtlGap}pts ahead of NYI. NYI plays MTL Apr 12 (H2H at home). Current rooting verdict: ${nyiMetRank<=2?'Root FOR MTL (keep in ATL = out of WC) — means root AGAINST BOS in BOS-MTL games. This flips if NYI drops to MET#3 or WC.':'Root AGAINST MTL — they are a direct WC threat.'}`;
      }
    }

    const gamesLeft = 82 - nyi.gp;
    const nyiProj = nyi.gp ? Math.round(nyi.pts + (nyi.pts/nyi.gp)*gamesLeft) : nyi.pts;

    const prompt = `You are AI Butchie Bot, the AI analyst for the NYI Castaways Playoff Push — a sharp, honest hockey analyst who's also a die-hard Islanders fan. You write like a beat writer with a supercomputer: specific, opinionated, and willing to say uncomfortable things when the numbers demand it.

PUSH GROUP STANDINGS (Eastern Conference playoff bubble):
${standingsStr}

TIEBREAKER SITUATIONS (teams within 3pts of NYI):
${tbLines.length ? tbLines.join('\n') : 'No close tiebreaker situations'}
${recentStr}${mtlContext}

NYI has ${gamesLeft} games remaining. Season ends April 16, 2026.

Generate TWO separate sets of insights as a JSON object with exactly these two keys:

"metro": 3-4 insights FOCUSED EXCLUSIVELY on NYI's Metropolitan Division finish.
- Is Metro #2 secure vs PIT? Can NYI catch Metro #1 (CAR)? What does Metro #3 mean vs Metro #2?
- Reference PIT's RW/ROW tiebreaker situation vs NYI specifically
- What H2H games remain that affect the Metro seeding?
- Be specific about what Metro #2 vs #3 means for playoff seeding and first-round matchup

"wildcard": 3-4 insights FOCUSED EXCLUSIVELY on the Wild Card picture.
- Which teams are threatening WC1 and WC2 from outside the top 3?
- BOS likely locks WC1 — what does that mean for WC2 competition?
- Which bubble teams (OTT, DET, PHI) are most dangerous and why?
- What pace does NYI need to hold WC2 or better?

Rules for ALL insights:
- Each insight is a standalone string, 2-3 sentences max
- Use specific numbers, team names, trends — no generic statements
- Be honest — if NYI is vulnerable, say so
- Avoid "every game matters" or "the race is tight"

Respond ONLY with valid JSON in this exact format. No preamble, no markdown:
{"metro": ["insight 1", "insight 2", "insight 3"], "wildcard": ["insight 1", "insight 2", "insight 3"]}`;

    // 9. Call OpenAI
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

    if (aiRes.status !== 200) throw new Error('OpenAI error ' + aiRes.status + ': ' + aiRes.body);

    const aiData = JSON.parse(aiRes.body);
    const content = aiData.choices?.[0]?.message?.content || '';
    console.log('OpenAI response:', content.slice(0, 200));

    // Parse JSON object with metro and wildcard keys
    let metroInsights = [], wildcardInsights = [];
    try {
      const cleaned = content.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.metro && Array.isArray(parsed.metro)) metroInsights = parsed.metro;
      if (parsed.wildcard && Array.isArray(parsed.wildcard)) wildcardInsights = parsed.wildcard;
      if (!metroInsights.length && !wildcardInsights.length) throw new Error('No insights parsed');
    } catch(e) {
      console.error('Parse error:', e.message);
      const lines = content.split('\n')
        .map(l => l.replace(/^[\d\-\.\*\s"]+/, '').replace(/"[\,]?$/, '').trim())
        .filter(l => l.length > 30);
      metroInsights = lines.slice(0, Math.ceil(lines.length/2));
      wildcardInsights = lines.slice(Math.ceil(lines.length/2));
    }

    // 10. Store insights
    const payload = {
      metro: metroInsights,
      wildcard: wildcardInsights,
      insights: [...metroInsights, ...wildcardInsights],
      generatedAt: new Date().toISOString(),
      triggers: newlyFinished,
      nyiPts: nyi.pts,
      nyiGp: nyi.gp
    };

    await store.setJSON('nyi-insights', payload);

    console.log('generate-insights: stored', metroInsights.length, 'metro +', wildcardInsights.length, 'wildcard insights');
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, metro: metroInsights.length, wildcard: wildcardInsights.length, triggers: newlyFinished })
    };

  } catch(e) {
    console.error('generate-insights error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
