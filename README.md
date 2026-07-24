# SLA — League Analytics

A fantasy football analytics app for the **Neighbas in Paris** Sleeper league,
built around the league's own custom scoring rather than any standard format.

Static site. No backend, no API keys, no build-time secrets — everything runs in
the browser against Sleeper's public, CORS-enabled API.

## Why custom scoring is the whole point

This is a 6-team **superflex, IDP-heavy** league. Seven of the twenty-one
starting slots are individual defensive players, and the defensive scoring is
weighted far above any default:

| | |
|---|---|
| Starters | QB, RB×3, WR×4, TE, SUPER_FLEX, K, **DL×3, LB×4, DB×3** |
| IDP | `idp_int` 10.0 · `idp_sack` 9.0 · `idp_ff` 4.0 · `idp_pass_def` 3.0 · `idp_tkl_solo` 1.5 · `idp_tkl_loss` 2.0 · `idp_qb_hit` 2.0 |
| Offence | Half-PPR (0.5), **TE premium** (+0.5 → 1.0 for TE), 4pt pass TD, 0.04 pass yd |

Because of this, Sleeper's precomputed `pts_ppr` / `pts_half_ppr` / `pts_idp`
fields are all wrong for this league. Every number in this app is computed by
multiplying the league's own 140-key `scoring_settings` against raw stat lines.

**Worked example** — Bryce Huff, week 5 2025: 1 sack, 1 QB hit, 1 solo tackle,
1 assist, 1 TFL. Sleeper's `pts_idp` says 12.0. Our scoring says **14.5**. The
14.5 is what this league actually awarded.

### Verified

`npm run verify` checks the scoring engine against ground truth — Sleeper's
`/matchups/{week}` endpoint returns `players_points` computed server-side with
this league's real settings.

```
compared      4194 player-weeks
mismatches    0
match rate    100.0000%
```

Team starter totals also reconcile exactly against Sleeper's reported matchup
points.

## The three metrics

**Custom score** — `scoring_settings` × raw stat keys. Exact, verified above.

**Value Score (0–1000)** — a season-long valuation blending 18 normalised
signals, each a percentile *within the player's own position group*. Production
dominates (PPG rank .18, total rank .14, last-8 .08, availability .08,
consistency .06); market signal is deliberately tiny (.005) as a tie-breaker.
Age is excluded — this is an in-season model, not a dynasty ranking. Small
samples blend toward neutral rather than being crushed to zero.

**Matchup Score (0–100)** — per-position-group defensive generosity, combining
rank base, recent trend, ceiling and floor rates, consistency and top-10 rate.
100 = softest defence in the league to face.

## Pages

| Page | What it answers |
|---|---|
| **Teams** | Roster by slot group, with a positional heatmap |
| **Matchups** | Head-to-head lineups, live custom-scored totals |
| **Optimal Lineup** | The best legal lineup, and what it cost to miss it |
| **Analytics** | Standings, power ranking, defensive generosity research |
| **History** | Season trend: actual vs projected vs optimal, week by week |
| **Trade** | Trade impact judged on optimal-lineup change, not raw value |
| **Players** | Searchable browser over free agents and rostered players |

Any player is clickable for a detail sheet with a projected-vs-actual chart, a
full season profile, a "why this Value Score" breakdown, and a week-by-week
table.

## Notable differences from the original app

These are deliberate corrections, not drift:

- **Optimal lineup is now exact.** The original filled fixed slots greedily then
  flex slots, which isn't guaranteed optimal in a superflex league. This uses a
  true maximum-weight bipartite matching.
- **Matchup scores rescale instead of clamping.** The old composite could exceed
  100 and got clipped — in 2025 three defences tied at exactly 100.0 against QBs
  and two sat at 0.0, destroying the ordering exactly where it mattered. Scores
  are now the composite's rank-percentile, giving a full spread.
- **Heatmaps are colourblind-safe.** The original used red→yellow→green, the
  textbook red/green confusion case. This uses a diverging blue↔red ramp with a
  neutral grey midpoint, centred on the league median, and every cell prints its
  number so colour is never the only encoding.
- **Injury status no longer leaks across weeks.** Sleeper reports injury status
  as of *now*; applying it to a historical week listed players as "Out" in weeks
  they actually played.
- **No API keys in the client.** The original shipped a live Groq key in the
  page source.

## Running it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run verify
```

```bash
npm run build
```

## Deploying

Pushing to `main` deploys via GitHub Actions (`.github/workflows/deploy.yml`).
Enable it once under **Settings → Pages → Source → GitHub Actions**.

The build uses a relative base path and a `HashRouter`, so it works from a
project page (`/SLA/`), a user page (`/`), or straight off disk — no server
rewrite rules needed.

## Adding a season

Add the league id to `SEASON_LEAGUES` in `src/data/league.ts`. Scoring settings,
roster slots and team names are all read from the league itself, so nothing else
needs changing even if the format does.

## Performance notes

A full season is ~11MB of JSON (17 weeks × stats + projections, plus a 2.5MB
player dictionary). It's cached in IndexedDB with per-payload TTLs: completed
weeks for 30 days, the live week for 2 minutes. Recharts is code-split, keeping
first paint to ~98KB gzipped.
