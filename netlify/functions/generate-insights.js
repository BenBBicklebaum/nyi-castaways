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

// ── Main handler ──────────────────────────────────────────────────

exports.handler = async (event, context) => {
  console.log('generate-insights: starting', new Date().toISOString());
  
  // Build store — try multiple ways to get siteID
  const siteID = process.env.NETLIFY_SITE_ID
    || process.env.SITE_ID
    || (context && context.site && context.site.id);
  const token = process.env.NETLIFY_AUTH_TOKEN
    || process.env.NETLIFY_BLOBS_TOKEN
    || process.env.TOKEN;

  console.log('generate-insights: siteID present:', !!siteID, '| token present:', !!token);

  if (!siteID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'NETLIFY_SITE_ID env var not set' }) };
  }

  // Log all relevant env vars for debugging
  console.log('ENV CHECK:', {
    hasNETLIFY_BLOBS_CONTEXT: !!process.env.NETLIFY_BLOBS_CONTEXT,
    hasNETLIFY_AUTH_TOKEN: !!process.env.NETLIFY_AUTH_TOKEN,
    hasNETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
    hasOPENAI: !!process.env.OPENAI_API_KEY
  });

  // If we have the Blobs context (normal scheduled/deployed runs), use default
  // If not (manual run from UI), try with explicit creds
  let store;
  if (process.env.NETLIFY_BLOBS_CONTEXT) {
    store = getStore('insights-cache');
  } else if (siteID && token) {
    store = getStore({ name: 'insights-cache', siteID, token });
  } else {
    return { statusCode: 500, body: JSON.stringify({ 
      error: 'Cannot initialize Blobs store — missing NETLIFY_BLOBS_CONTEXT or token',
      siteID: !!siteID, token: !!token
    })};
  }

  try {
    // 1. Fetch today's scores
    const scRes = await fetchUrl('https://api-web.nhle.com/v1/score/now');
    if (scRes.status !== 200) throw new Error('Scores fetch failed: ' + scRes.status);
    const scData = JSON.parse(scRes.body);

    // 2. Build current game state snapshot for push group games
    // Key: gameId, Value: { away, home, state, awayScore, homeScore }
    const currentSnapshot = {};
    const finishedGames = [];

    // Broad Eastern teams — we don't have dynamic RACE_GROUP yet at this stage,
    // so include all plausible East playoff contenders. Pruning happens in prompt context.
    const EAST_CONTENDERS = new Set([
      'NYI','OTT','BOS','PHI','PIT','CBJ','DET','WSH','NJD','TBL','BUF','MTL','TOR','FLA','CAR','NYR'
    ]);
    (scData.games || []).forEach(g => {
      const away = g.awayTeam?.abbrev, home = g.homeTeam?.abbrev;
      if (!EAST_CONTENDERS.has(away) && !EAST_CONTENDERS.has(home)) return;
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
      const prev = await store.get('game-snapshot', { type: 'json' });
      if (prev) previousSnapshot = prev;
    } catch(e) { /* no previous snapshot */ }

    try {
      const existing = await store.get('nyi-insights', { type: 'json' });
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
    // Always regenerate — cron runs hourly so this is fine
    // Manual runs from UI should always produce fresh insights
    const shouldGenerate = true;        // Fallback: regenerate daily even if no games

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
    // Load all Eastern teams + relevant Western context
    (stData.standings || []).forEach(row => {
      const abbrev = (row.teamAbbrev && typeof row.teamAbbrev === 'object')
        ? row.teamAbbrev.default : row.teamAbbrev;
      if (!abbrev) return;
      const conf = (row.conferenceAbbrev||'').startsWith('E') ? 'E' : 'W';
      const divMap = {'A':'ATL','M':'MET','C':'CEN','P':'PAC'};
      const div = divMap[row.divisionAbbrev]||row.divisionAbbrev||'';
      ST[abbrev] = {
        pts: row.points||0, gp: row.gamesPlayed||0,
        wins: row.wins||0, losses: row.losses||0, otl: row.otLosses||0,
        rw: row.regulationWins||0, row: row.regulationPlusOtWins||0,
        diff: row.goalDifferential||0,
        l10w: row.l10Wins||0, l10l: row.l10Losses||0, l10otl: row.l10OtLosses||0,
        streak: row.streakCode||'',
        conf, div
      };
    });

    // 8. Build race group dynamically from standings
    // Derive who holds each relevant spot
    const eastTeams = (stData.standings || []).filter(row => {
      const conf = row.conferenceAbbrev || '';
      return conf.startsWith('E');
    }).map(row => {
      const abbrev = (row.teamAbbrev && typeof row.teamAbbrev === 'object')
        ? row.teamAbbrev.default : row.teamAbbrev;
      return abbrev;
    }).filter(Boolean);

    // Sort Eastern teams by pts (already done via ST)
    const eastSorted = Object.entries(ST)
      .filter(([,s]) => s.conf === 'E')
      .sort((a,b) => b[1].pts - a[1].pts);

    // Wild card pool: all Eastern non-division-leader teams sorted by pts
    const metroTeams = (stData.standings || [])
      .filter(r => r.divisionAbbrev === 'M')
      .map(r => (r.teamAbbrev && typeof r.teamAbbrev === 'object') ? r.teamAbbrev.default : r.teamAbbrev)
      .filter(Boolean);
    const atlTeams = (stData.standings || [])
      .filter(r => r.divisionAbbrev === 'A')
      .map(r => (r.teamAbbrev && typeof r.teamAbbrev === 'object') ? r.teamAbbrev.default : r.teamAbbrev)
      .filter(Boolean);

    // Sort each division by pts
    const sortDiv = (teams) => teams
      .filter(t => ST[t])
      .sort((a,b) => ST[b].pts - ST[a].pts);
    const metSorted = sortDiv(metroTeams);
    const atlSorted = sortDiv(atlTeams);

    // WC pool: teams not in top-3 of their division, sorted by pts
    const metTop3 = new Set(metSorted.slice(0,3));
    const atlTop3 = new Set(atlSorted.slice(0,3));
    const wcPool = [...eastSorted.map(([t]) => t)]
      .filter(t => !metTop3.has(t) && !atlTop3.has(t))
      .slice(0, 4); // WC1, WC2, and next 2

    const wc1Holder = wcPool[0] && wcPool[0] !== 'NYI' ? wcPool[0] : wcPool[1];
    const wc2Holder = wcPool[1] && wcPool[1] !== 'NYI' ? wcPool[1] : wcPool[2];
    const metTop3List = metSorted.slice(0,3);
    const met3Holder = metTop3List.find(t => t !== 'NYI' && metTop3List.indexOf(t) === 2)
                    || metTop3List.filter(t => t !== 'NYI')[1]
                    || null;
    const met2Holder = metTop3List.find(t => t !== 'NYI' && metTop3List.indexOf(t) === 1)
                    || metTop3List.filter(t => t !== 'NYI')[0]
                    || null;

    // Dynamic race group — same logic as rebuildRaceGroup() in index.html
    // threshold = min(nyiGl + 2, 4): tightens as season ends, never wider than 4pts
    const nyi = ST['NYI'];
    const nyiGl = 82 - (nyi.wins + nyi.losses + nyi.otl);
    const threshold = Math.min(nyiGl + 2, 4);
    const wc2Pts = wc2Holder && ST[wc2Holder] ? ST[wc2Holder].pts : 0;

    const dynamicRaceGroup = new Set(['NYI']);

    // WC pool: within threshold pts of WC2 AND mathematically alive
    wcPool.forEach(t => {
      if(!t || !ST[t]) return;
      const s = ST[t];
      const gl = 82 - (s.wins + s.losses + s.otl);
      const maxPts = s.pts + gl * 2;
      const gap = wc2Pts - s.pts;
      if(gap <= threshold && maxPts >= wc2Pts) dynamicRaceGroup.add(t);
    });

    // Metro: within threshold pts of NYI in either direction AND mathematically relevant
    metSorted.forEach(t => {
      if(!t || !ST[t] || t === 'NYI') return;
      const s = ST[t];
      const gl = 82 - (s.wins + s.losses + s.otl);
      const maxPts = s.pts + gl * 2;
      const gap = Math.abs(s.pts - nyi.pts);
      const nyiCanCatch = nyi.pts + nyiGl * 2 >= s.pts;
      const theyCanCatch = maxPts >= nyi.pts;
      if(gap <= threshold && (nyiCanCatch || theyCanCatch)) dynamicRaceGroup.add(t);
    });

    // 9. Build rich prompt context
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

    const gamesLeft = nyiGl; // alias — already computed above
    const today = new Date().toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'});

    // 10. Fetch NYI schedule from NHL API (remaining games only)
    let nyiSchedStr = 'Schedule unavailable';
    let nyiH2H = [];
    let bubbleSchedStr = 'Rival schedules unavailable';
    try {
      const schedRes = await fetchUrl('https://api-web.nhle.com/v1/club-schedule-season/NYI/now');
      if (schedRes.status === 200) {
        const schedData = JSON.parse(schedRes.body);
        const todayET = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
        const todayStr = todayET.toISOString().slice(0,10);
        const nyiGames = (schedData.games || []).filter(g => {
          const state = g.gameState || '';
          return g.gameDate >= todayStr && state !== 'OFF' && state !== 'FINAL';
        }).slice(0, nyi ? 82 - nyi.gp : 10);

        nyiH2H = nyiGames.filter(g => {
          const opp = g.awayTeam?.abbrev === 'NYI' ? g.homeTeam?.abbrev : g.awayTeam?.abbrev;
          return dynamicRaceGroup.has(opp);
        });

        nyiSchedStr = nyiGames.map(g => {
          const opp = g.awayTeam?.abbrev === 'NYI' ? g.homeTeam?.abbrev : g.awayTeam?.abbrev;
          const ha = g.homeTeam?.abbrev === 'NYI' ? 'vs' : '@';
          const dateStr = new Date(g.gameDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
          const rival = dynamicRaceGroup.has(opp) ? ' [RIVAL]' : '';
          return `${dateStr}: ${ha}${opp}${rival}`;
        }).join(', ') || 'No remaining games';
      }
    } catch(e) {
      console.warn('NYI schedule fetch failed:', e.message);
    }

    // 11. Fetch rival schedules from NHL API dynamically
    const rivals = [...dynamicRaceGroup].filter(t => t !== 'NYI' && ST[t]);
    const bubbleScheds = {};
    await Promise.all(rivals.slice(0, 6).map(async team => {
      try {
        const r = await fetchUrl(`https://api-web.nhle.com/v1/club-schedule-season/${team}/now`);
        if (r.status !== 200) return;
        const d = JSON.parse(r.body);
        const todayET = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
        const todayStr = todayET.toISOString().slice(0,10);
        const remaining = (d.games || []).filter(g => {
          const state = g.gameState || '';
          return g.gameDate >= todayStr && state !== 'OFF' && state !== 'FINAL';
        });
        bubbleScheds[team] = remaining.map(g => {
          const opp = g.awayTeam?.abbrev === team ? g.homeTeam?.abbrev : g.awayTeam?.abbrev;
          const ha = g.homeTeam?.abbrev === team ? 'vs' : '@';
          const dateStr = new Date(g.gameDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
          return `${dateStr} ${ha}${opp}`;
        }).join(', ') || 'done';
      } catch(e) { bubbleScheds[team] = 'unavailable'; }
    }));

    bubbleSchedStr = Object.entries(bubbleScheds)
      .map(([t, sched]) => {
        const s = ST[t];
        const gl = s ? 82-(s.wins+s.losses+s.otl) : 0;
        return `${t} (${s?s.pts:0}pts, ${gl}GL): ${sched}`;
      }).join('\n');

    const nyiProj = nyi.gp ? Math.round(nyi.pts + (nyi.pts/nyi.gp)*gamesLeft) : nyi.pts;

    // Key tiebreaker facts for prompt — using dynamic holders
    const phi = met3Holder ? ST[met3Holder] : null;
    const ott = wc2Holder ? ST[wc2Holder] : null;
    const det = ST['DET'], cbj = ST['CBJ'], wsh = ST['WSH'];
    const phiGap = phi ? phi.pts - nyi.pts : 0;
    const ottGap = ott ? ott.pts - nyi.pts : 0;

    // Derive bubble chasers (non-NYI, outside playoff line, within 6 pts of WC2)
    const bubbleChasers = [...dynamicRaceGroup]
      .filter(t => t !== 'NYI' && ST[t] && !metTop3.has(t) && !atlTop3.has(t) && t !== wc1Holder && t !== wc2Holder)
      .sort((a,b) => ST[b].pts - ST[a].pts)
      .slice(0,3);
    const bubbleChasersStr = bubbleChasers.map(t => `${t} (${ST[t].pts}pts)`).join(', ');

    // WC1 context
    const wc1 = wc1Holder ? ST[wc1Holder] : null;
    const wc1Gap = wc1 ? wc1.pts - nyi.pts : 0;

    // NYI's current position label
    const nyiInMet = metSorted.indexOf('NYI');
    const nyiInWC = wcPool.indexOf('NYI');
    const nyiPosLabel = nyiInMet >= 0 && nyiInMet < 3
      ? `Metro #${nyiInMet+1}`
      : nyiInWC >= 0 && nyiInWC < 2
        ? `WC${nyiInWC+1}`
        : 'OUT of a playoff spot';

    const prompt = `You are AI Butchie Bot — a sharp NHL analyst for New York Islanders fans. Return ONLY a JSON object, nothing else.

CURRENT RACE CONTEXT:
NYI (${nyi.pts}pts, ${nyi.wins}-${nyi.losses}-${nyi.otl}, ${gamesLeft}GL) | RW:${nyi.rw} ROW:${nyi.row}
NYI is currently ${nyiPosLabel}. ${met3Holder ? `They need to pass ${met3Holder} for Metro #3` : ''}${met3Holder && wc2Holder ? ' AND/OR ' : ''}${wc2Holder && wc2Holder !== met3Holder ? `pass ${wc2Holder} for WC2` : ''}.

STANDINGS DATA (race group):
${standingsStr}

TIEBREAKER SITUATIONS (teams within 3pts of NYI):
${tbLines.length ? tbLines.join('\n') : 'None'}
${recentStr}

Season ends April 16, 2026. Today is ${today}. NYI has ${gamesLeft} games left.
${wc1Holder ? `${wc1Holder} holds WC1 at ${wc1?wc1.pts:0}pts — ${wc1Gap}pts ahead of NYI. WC1 is ${wc1Gap > 4 ? 'NOT in reach' : 'potentially reachable'}.` : ''}

DIVISION STRUCTURE (critical — never mix these up):
- METROPOLITAN DIVISION: CAR, NYI, PIT, CBJ, PHI, WSH, NJD, NYR
- ATLANTIC DIVISION: BUF, TBL, MTL, BOS, OTT, DET, TOR, FLA
- Atlantic WC teams (${wc2Holder||'?'}, ${wc1Holder||'?'}) are NOT Metro rivals
${met3Holder ? `- ${met3Holder} holds Metro #3 (${phi?phi.pts:0}pts) — NYI's Metro target` : '- NYI may already hold Metro #3'}
${wc2Holder ? `- ${wc2Holder} holds WC2 (${ott?ott.pts:0}pts) — NYI's Wild Card target` : ''}
${bubbleChasers.length ? `- ${bubbleChasersStr} are chasing from below` : ''}

NYI REMAINING SCHEDULE (${gamesLeft} games): ${nyiSchedStr}
NYI H2H vs RIVALS remaining: ${nyiH2H.length ? nyiH2H.length + ' games' : 'None'}

RIVAL REMAINING SCHEDULES:
${bubbleSchedStr}

ONLY reference games listed above. NEVER invent games not on these lists.

Return this exact JSON — NO other text, NO markdown:
{"metro":["insight1","insight2","insight3"],"wildcard":["insight1","insight2","insight3"]}

METRO insights (exactly 3) — focus on NYI vs ${met3Holder||'Metro #3 target'} for Metro #3:

- Insight 1: ${met3Holder||'Metro #3'} tiebreaker analysis. ${met3Holder} leads NYI by ${phiGap}pts. State ${met3Holder}'s RW vs NYI's RW. If NYI closes the pts gap, who wins the tiebreaker? Estimate: ~55% of wins come in regulation. Be precise with numbers.
- Insight 2: Scenario math. MATH RULES: win=2pts, OTL=1pt, loss=0pts. NYI has ${nyi.pts}pts. ${met3Holder||'Metro #3 holder'} has ${phi?phi.pts:0}pts with ${phi?82-(phi.wins+phi.losses+phi.otl):0}GL. If NYI goes X-Y in ${gamesLeft} games, do they pass ${met3Holder||'them'}? Show the specific math. Only compare NYI to METRO teams (CAR, PIT, CBJ, PHI, WSH, NJD, NYR).
- Insight 3: Pick one specific upcoming NYI game from NYI REMAINING SCHEDULE. Analyze its dual impact — direct pts for NYI AND effect on a Metro rival if applicable. Atlantic teams (${wc2Holder||'OTT'}, DET) are NOT Metro teams.
- NEVER mention Atlantic teams as Metro rivals
- Max 2 sentences. Every sentence must contain a number.

WILDCARD insights (exactly 3) — focus on NYI chasing ${wc2Holder||'WC2'}, fending off ${bubbleChasersStr||'bubble teams'}:

- Insight 1: Points math. NYI has ${nyi.pts}pts (${gamesLeft}GL). ${wc2Holder||'WC2 holder'} has ${ott?ott.pts:0}pts (${ott?82-(ott.wins+ott.losses+ott.otl):0}GL). NYI needs ${ottGap>0?ottGap+' more pts just to tie '+wc2Holder:'to maintain their lead'}. Project both teams' final totals at current pace. Show the arithmetic explicitly.
- Insight 2: Identify a specific rival-vs-rival game from RIVAL REMAINING SCHEDULES. MATH: when Team A beats Team B, Team B gets 0pts — they don't gain anything. State the date, teams, and what it means for NYI's gap vs both teams.
- Insight 3: Schedule difficulty. Use RIVAL REMAINING SCHEDULES to show which rival has the toughest or easiest remaining path. Only cite opponents actually listed in their schedule above.
- Metro-only teams (PIT, PHI, NJD, NYR, WSH, CBJ, CAR) are NOT in the Wild Card race unless they appear in the standings bubble
- NEVER use pts/game rates — say "X pts in Y games"
- NEVER invent games
- Max 2 sentences. Every sentence must contain a number.

CRITICAL: Return valid JSON only. No text before or after.`;

    // 12. Call OpenAI
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const aiRes = await postJson(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 1200,
        temperature: 0.75,
        messages: [{ role: 'user', content: prompt }]
      },
      { 'Authorization': 'Bearer ' + apiKey }
    );

    if (aiRes.status !== 200) throw new Error('OpenAI error ' + aiRes.status + ': ' + aiRes.body);

    const aiData = JSON.parse(aiRes.body);
    const content = aiData.choices?.[0]?.message?.content || '';
    console.log('OpenAI response:', content.slice(0, 200));

    // Parse JSON robustly
    let metroInsights = [], wildcardInsights = [];
    try {
      // Try 1: parse the full content directly
      let parsed = null;
      try {
        parsed = JSON.parse(content.trim());
      } catch(e1) {
        // Try 2: extract { ... } block
        const start = content.indexOf('{');
        // Find the matching closing brace by counting
        let depth = 0, end = -1;
        for (let i = start; i < content.length; i++) {
          if (content[i] === '{') depth++;
          else if (content[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (start === -1 || end === -1) throw new Error('No complete JSON object found');
        parsed = JSON.parse(content.slice(start, end + 1));
      }
      if (parsed.metro && Array.isArray(parsed.metro)) {
        metroInsights = parsed.metro.filter(s => typeof s === 'string' && s.length > 10).slice(0, 3);
      }
      if (parsed.wildcard && Array.isArray(parsed.wildcard)) {
        wildcardInsights = parsed.wildcard.filter(s => typeof s === 'string' && s.length > 10).slice(0, 3);
      }
      if (!metroInsights.length && !wildcardInsights.length) throw new Error('Both arrays empty');
      console.log('generate-insights: parsed', metroInsights.length, 'metro,', wildcardInsights.length, 'wildcard');
    } catch(e) {
      console.error('Parse error:', e.message, '| content length:', content.length, '| sample:', content.slice(0, 200));
      return { statusCode: 500, body: JSON.stringify({ error: 'JSON parse failed: ' + e.message }) };
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

    await store.set('nyi-insights', JSON.stringify(payload));

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
