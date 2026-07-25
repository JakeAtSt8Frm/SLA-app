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

**Value Score (0–1000)** — the headline, market-independent **Intrinsic Dynasty
Value**. It is cross-position and cardinal: a large lineup advantage is worth
more than a small one, even when the players occupy different positions.

- Production is estimated with a game-weighted Bayesian blend. Current games
  count 1.0 each, prior-year games 0.55, and two-year-old games 0.30, with an
  eight-game position/role prior. One early-season outlier therefore cannot
  erase a full prior season.

- The application assigns the league-wide player pool to every starting slot
  with the same exact maximum-weight matcher used by the Optimal Lineup page.
  Removing the marginal starter and resolving the assignment produces the
  starter baseline without hardcoded flex splits. The best unrostered player is
  a second waiver baseline.

- Three discounted future seasons convert projected PPG into expected lineup
  points over both baselines. Position-specific age curves change future
  production and role survival inside that projection. Role, insulation,
  efficiency and expected availability support the main production term.

- *Current Form* remains the age- and market-blind 11-signal in-season model:
  PPG, exponentially weighted form, current projection, opportunity share,
  snaps, recent production and supporting usage/availability signals. It is
  displayed separately because it predicts a different target.

- *Market Value* from [FantasyCalc](https://fantasycalc.com) is normalized
  separately and never enters Intrinsic Value. The market-free gap drives the
  **Buy-low / Sell-high / Fair** verdict. A separate *Consensus Value* is 75%
  intrinsic and 25% market. Objective NFL draft capital from the feed may inform
  a rookie prior; FantasyCalc price, rank, ADP and trade frequency may not.

Every dynasty input is best-effort: failed market or prior-season fetches
degrade gracefully rather than blocking the application. FantasyCalc does not
price IDPs, so those players keep a fully intrinsic score and show no market
verdict.

**Matchup Score (0–100)** — a contextual next-week rating. It combines the
defence-only generosity model (.35), opponent-adjusted concessions (.15),
opportunity volume allowed (.10), and the historical strength of the player's
offensive or IDP unit (.40). The Analytics page keeps the defence-only view so
teams remain directly comparable; player-facing scores include the unit context.

The weights were selected on leakage-safe 2024 observations and evaluated once
on a 2025 holdout. Value's next-week rank correlation improved from .610 to
.653; contextual matchup correlation improved from .088 to .235. Run
`npm run research` to reproduce the full signal report.

## Pages

| Page | What it answers |
|---|---|
| **Teams** | Roster by slot group, with a positional heatmap |
| **Optimal Lineup** | The best legal lineup, and what it cost to miss it |
| **History** | Season trend: Projected vs Actual vs Optimal, week by week |
| **Available Players** | Searchable browser over free agents and rostered players |
| **Schedule** | The NFL week with rostered players, owners and custom scores overlaid |
| **Analytics** | Standings, all-play record, schedule luck, power index, volatility and defensive generosity |

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
- **Heatmaps normalise around the league median.** The red→yellow→green scale is
  kept from the original, but centred on the median rather than the min, so
  yellow honestly means "typical" even when one team has a runaway week.
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
npm run verify:dynasty
```

```bash
npm run research
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

Team-week views are memoized for the lifetime of a loaded season, so pages that
share optimal-lineup, history and analytics data reuse the same derived result
instead of rerunning the lineup matcher.

## A note on the colour scale

Value scores, rank pills and heatmaps use red → yellow → green, matching the
original app. That scale is hard to read with the most common colour-vision
deficiencies, so nothing depends on colour alone: every heatmap cell prints its
value and offers a Table toggle, every chip prints its score, rank pills print
"#11 Total", and boom/bust always ships an arrow icon plus a text label. Chart
lines are the exception and use a CVD-validated categorical pair, since a line
cannot label every point.
