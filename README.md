# NYI Castaways Playoff Push — Next Season Setup Guide

This document covers everything you need to update when rebuilding the dashboard for next season. Most logic is fully dynamic — this is the short list of what actually needs a human touch.

---

## Quick Launch Checklist

- [ ] Replace `FULL_SCHEDULE` in `index.html` with new season schedule
- [ ] Update `parseGameDate()` year in `index.html`
- [ ] Update score nav ceiling in `index.html`
- [ ] Update page title and `<h1>` year
- [ ] Update `"Season ends April XX, 20XX"` in `generate-insights.js`
- [ ] Check for new/relocated teams — update `TEAM_INFO` and `TEAM_COLORS` if needed
- [ ] Confirm Netlify env vars are still set
- [ ] Deploy, confirm scheduled function fires
- [ ] Verify MoneyPuck CSV endpoint still resolves

**Estimated setup time: 1–2 hours** (mostly the schedule — ask Claude to pull it from the NHL API)

---

## 1. `FULL_SCHEDULE` in `index.html`

**What:** Large JSON object (~line 434) with every NHL team's full regular season schedule in `["Mon DD", "OPP", "H/A"]` format.

**Why hardcoded:** Powers `remaining()`, SOS, H2H, magic/tragic numbers, and the "next game" bar. The `remaining()` function uses `ST[team].gp` (games played from live standings) to slice the schedule — so completed games drop off automatically the moment standings update. This means the schedule only needs to be accurate, not maintained mid-season.

**How to update:**
Ask Claude in October: *"Pull the full 2026-27 NHL schedule from the API and format it as a FULL_SCHEDULE object matching this pattern: `{"NYI": [["Oct 9", "TOR", "H"], ...], ...}`"*

Claude can hit `https://api-web.nhle.com/v1/club-schedule-season/{TEAM}/now` for each of the 32 teams and format it in one shot.

Here is link to github nhl api documentation: https://github.com/Zmalski/NHL-API-Reference
---

## 2. `parseGameDate()` year in `index.html`

**What:** Line ~537:
```js
return new Date(2026, MONTHS[p[0]], parseInt(p[1]));
```

**How to update:** Change `2026` to the year the season **ends** (e.g., `2027` for the 2026-27 season). The NHL regular season always ends in April.

---

## 3. Score nav forward ceiling in `index.html`

**What:** Line ~1613:
```js
_scoreOffset = Math.max(-14, Math.min(11, _scoreOffset + dir));
```

The `11` caps forward navigation. It was set to +11 days from the launch date = season end date.

**How to update:** Recalculate: `season_end_date - your_launch_date` in days. Or use this cleaner approach (set it once and forget):
```js
const SEASON_END = new Date(2027, 3, 18); // Apr 18 2027 — update each season
const daysLeft = Math.ceil((SEASON_END - todayDate()) / 86400000);
_scoreOffset = Math.max(-14, Math.min(Math.max(0, daysLeft), _scoreOffset + dir));
```

---

## 4. Page title and `<h1>`

**What:**
- `<title>NYI Castaways Playoff Push 2026</title>` (line 6)
- `<h1>NYI Castaways <span>Playoff Push 2026</span></h1>` (line ~219)

**How to update:** Change `2026` to the new season year.

---

## 5. `"Season ends April 16, 2026"` in `generate-insights.js`

**What:** Line ~391 of the AI prompt passed to GPT-4o-mini.

**How to update:** Change to the actual last day of the new regular season. The NHL publishes the full schedule in late June/early July.

---

## 6. `TEAM_INFO` and `TEAM_COLORS` in `index.html`

**What:** Maps of team abbreviations to `[conference, division]` and primary hex color. Used throughout for standings sorting, division logic, and score card colors.

**When to update:** Only if the NHL adds an expansion team, relocates a franchise, or changes an abbreviation. The 2025-26 version already includes UTA (Utah). Check for announcements in the offseason.

---

## 7. Netlify Environment Variables

Confirm these are still set in Netlify → Site settings → Environment variables:

| Variable | Purpose |
|---|---|
| `NETLIFY_SITE_ID` | Required for Blobs (Butchie Bot cache) |
| `NETLIFY_AUTH_TOKEN` | Required for Blobs |
| `OPENAI_API_KEY` | Required for Butchie Bot AI insights |

If Butchie Bot was still hidden (`display:none`) — re-enable it in `index.html` if the quality improved, or leave it hidden.

---

## 8. MoneyPuck CSV endpoint

The dashboard fetches:
```
https://moneypuck.com/moneypuck/simulations/simulations_recent.csv
```

This URL has been stable for years but worth a quick check in October — open it in a browser and confirm it returns CSV data with an `ALL,NYI` row. If the URL changes, update it in `nhl.js` in the `type === 'moneypuck'` handler.

---

## What Does NOT Need Updating (fully dynamic)

Everything else runs off live NHL API data and standings math. Zero maintenance mid-season:

| Feature | Why automatic |
|---|---|
| `RACE_GROUP` | Rebuilt after every standings load using `nyiGl + 2` threshold, capped at 4pts |
| Race table teams | `wcPool()` + `sortedDiv()` from live standings |
| Clinch Tracker seeds | `threshTeam()` looks up whoever holds each seed live |
| Metro #3 / WC2 targets | Derived from `met[]` and `wcp[]` arrays |
| Magic & tragic numbers | Pure math from live standings |
| Tiebreaker logic | Pure RW → ROW → W comparison (pts-independent) |
| Playoff probability | Gap-to-probability with hard elimination floor (0% when mathematically out) |
| Rival schedules (Butchie Bot) | Fetched live from NHL API each run |
| NYI remaining schedule (Butchie Bot) | Fetched live from NHL API each run |
| Score cards → NHL.com links | `gameCenterLink` returned by NHL scores API |
| Goal scorers in score cards | `goals[]` array from NHL scores API |
| MoneyPuck odds | Live CSV fetch via Netlify proxy |
| SOS calculations | Derived from `FULL_SCHEDULE` + live standings pts% |
| Remaining games display | `remaining()` uses `ST[team].gp` — completed games drop off automatically |
| `RACE_GROUP` in Butchie Bot prompt | Dynamically built from standings each run |
| Observations (Metro/WC) | Target teams derived from live standings, not hardcoded |
| Scenario math | Calculated from live pts, GP, and projected pace |
| News feed | Google News RSS proxy, no maintenance |

---

## Lessons from 2025-26

Things that needed fixing mid-season that are now addressed — don't re-introduce these:

- **`tbEdge()` must be pts-independent.** It was previously using `tbCompare()` which started with pts, causing wrong tiebreaker colors and magic number calculations. The current version compares only RW → ROW → W.
- **`posProb()` needs a hard 0% floor.** Probability can never be non-zero when `NYI max pts < rival current pts`. The gap-table's floor of 5% was showing impossible probabilities. The current version checks mathematical elimination first.
- **`rebuildRaceGroup()` WC reference must be WC2, not WC1.** Using `wcp.find()` was accidentally using WC1 as the reference point, including BOS and excluding OTT. Always use `wcp[1]` as the WC2 reference.
- **`remaining()` must use GP not date.** Date-based filtering (`>= today`) kept today's completed games on the schedule chip list all day. GP-based slicing (`sched.slice(gp)`) drops them the moment standings update.
- **Race table bubble threshold must be `min(nyiGl + 2, 4)`.** A hardcoded 6 or 8 point window pulled in too many teams (BUF, TBL, etc.) late in the season when the field should be tight.
- **Score color logic must be symmetric.** Both scores should be the same color (both green, both red, both white) based on whether the root team is winning. Per-side coloring was confusing.
- **Metro section mirrors WC structure.** Metro #3 holder at top (the target), then "Chasing" banner, then NYI + others. Don't group NYI with PHI.

---

## File Map

| File | Location in repo | Purpose |
|---|---|---|
| `index.html` | `/` (repo root) | Entire frontend — all JS/CSS inline |
| `nhl.js` | `/netlify/functions/` | Netlify serverless proxy (standings, scores, MoneyPuck, news) |
| `generate-insights.js` | `/netlify/functions/` | Hourly Butchie Bot AI insights generator |
| `netlify.toml` | `/` (repo root) | Netlify config — function scheduling, build settings |

**Repo:** `BenBBicklebaum/nyi-castaways`
**Branches:** `main` = production, `dev` = staging
**Analytics:** Google Analytics tag `G-W2JLY4BXGR` — in `<head>` of `index.html`

---

*Last updated: April 2026 — covers the 2025-26 NYI Castaways Playoff Push season.*
*Next season setup should take 1–2 hours. The hardest part is FULL_SCHEDULE — ask Claude.*
