# SLA — League Analytics

A fantasy football analytics app for the **Neighbas in Paris** Sleeper league,
built around the league's own custom scoring rather than any standard format.

Static site. No backend, API keys or build-time secrets. League data loads in
the browser from Sleeper; public FFToday and FantasySharks projection snapshots
are refreshed by the Pages build, because neither site allows browser
cross-origin requests.

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

**Value Score (0–1000)** — the headline number, the **average of two
within-position valuations**: an in-season half and a dynasty half. Every signal
in both is a percentile *within the player's own position group*, which is what
lets the two be averaged and read the same way — "top of his own pool", not
comparable across positions.

- *In-season half* blends 11 signals, prioritising PPG (.22), exponentially
  weighted form (.16), the current projection (.14), recent team opportunity
  share (.12), recent snap share (.11), last-four production (.08) and
  schedule-adjusted PPG (.07); usage, floor, availability and efficiency provide
  the rest. This half is age- and market-blind: pure "producing now".

- *Dynasty half* answers "what should this player be worth to hold". Its lead
  signal is multi-year **VORP** — observed production blended across the current
  and prior two seasons, plus a three-source consensus forecast (see
  [Projection sources](#projection-sources)), each source independently scored
  in *this* league's format. When only one source covers a player, that source
  remains usable. The ensemble projection is 40% of the production
  blend before a player records a game and fades to 15% after six games; it is
  never added to actual points. VORP then subtracts the group's real replacement
  level from the league's actual superflex/IDP starting requirements. On top of
  it: a position-specific age/longevity curve, projected or observed role and
  usage, value insulation, efficiency, availability, and — the one thing
  Sleeper can't provide — the current trade market from
  [FantasyCalc](https://fantasycalc.com) (superflex- and size-matched, keyed by
  Sleeper id). The gap between the intrinsic dynasty score and the market price
  surfaces in the player sheet as a **Buy-low / Sell-high / Fair** verdict,
  alongside contender- and rebuilder-lens scores. FantasyCalc doesn't price
  IDPs, so DL/LB/DB fall back to a production-only dynasty valuation with a
  neutral market leg.

Both halves show their own "why" breakdown in the player sheet. Every dynasty
input is best-effort: a failed market or prior-season fetch degrades that half
gracefully rather than blocking the app, and a player with only one half carries
that half as his Value Score.

**Matchup Score (0–100)** — a contextual next-week rating. It combines the
defence-only generosity model (.35), opponent-adjusted concessions (.15),
opportunity volume allowed (.10), and the historical strength of the player's
offensive or IDP unit (.40). The Analytics page keeps the defence-only view so
teams remain directly comparable; player-facing scores include the unit context.

The weights were selected on leakage-safe 2024 observations and evaluated once
on a 2025 holdout. Value's next-week rank correlation improved from .610 to
.653; contextual matchup correlation improved from .088 to .235. Run
`npm run research` to reproduce the full signal report.

## Projection sources

Three independent full-season forecasts feed the dynasty half. **No source's own
fantasy point total is ever imported** — every site publishes one, computed under
its own house format, and all of them are discarded. Only the raw projected stat
lines cross the boundary, and each is then re-scored against this league's 61
live scoring keys by the same engine that scores real games.

That means an imported column is only worth something if Sleeper both *names*
the stat that way and reports it in real game logs; anything else would either
credit points no player can earn or silently score zero. Every key both
importers emit was checked against 2025 game logs and is either a league scoring
key or one of seven declared usage-only keys (`gp`, `pass_att`, `pass_cmp`,
`rush_att`, `rec_tgt`, `fga`, `xpa`) carried purely to rank role and volume.
`npm run verify:projections` fails on any key that is neither.

Four IDP categories the league scores have no projection anywhere — `idp_qb_hit`
(2.0), `idp_tkl_loss` (2.0), `idp_safe` and `idp_blk_kick`. Nobody forecasts
them, so every defender is short the same categories, and the scale-matching
below is what keeps that from reading as a real difference between players.

| Source | Rows | Covers | Why it's here |
|---|---|---|---|
| [Sleeper](https://api.sleeper.app/projections/nfl/2026) | ~9,400 | everyone | The widest net, and the only one keyed by the ids the app already uses |
| [FFToday](https://www.fftoday.com/rankings/playerproj.php?PosID=10&LeagueID=193033) | 680 | QB–TE, DL/LB/DB | An independent house view on the startable pool |
| [FantasySharks](https://www.fantasysharks.com/projections/) | 1,337 | QB–TE, **K**, DL/LB/DB | Twice the IDP depth of FFToday, plus the only source publishing targets and field goals by distance |

FantasySharks is what a 21-slot superflex IDP league actually needs. It carries
753 defenders against FFToday's 325, and it publishes the assisted tackles,
passes defensed and forced fumbles this league weights heavily, targets rather
than bare receptions, and field goals split into the five distance buckets the
league scores separately. FFToday deliberately contributes no kickers: it
publishes one made-field-goal total, and splitting that across the buckets would
be inventing a distribution rather than importing one.

**The sources are scale-matched before they are averaged.** They do not all
measure the same things — Sleeper's season projection omits passes defensed
entirely (3 points each here, leaving its defensive backs about a fifth light),
carries no kicking attempts at all, and reports receptions where FantasySharks
reports targets, a 60% difference in "opportunity" by definition alone. Averaged
raw, that leaves a player's projection depending on *which* sources happened to
cover him: a deep defensive back only Sleeper lists would sit a fifth below an
identical one all three list, purely as an artefact of coverage. Since every
downstream use is a percentile within the position group, only each source's
*ordering* carries information, so each source is rescaled by one positive factor
per position group — its ordering is untouched and the level disagreement goes
away. In practice those factors run 0.90–1.13 on points and 0.75–1.21 on usage.
The player sheet still shows each source's total exactly as published.

`npm run verify:projections` checks both importers against fixtures, asserts the
checked-in snapshots still carry every position group, and confirms calibration
is order-preserving.

Rankings that publish only an ordering, rather than a stat line, can't be used
here — there is nothing to run the league's scoring against.

## Pages

| Page | What it answers |
|---|---|
| **Teams** | Roster by slot group, with a positional heatmap |
| **Optimal Lineup** | The best legal lineup, and what it cost to miss it |
| **History** | Season trend: Projected vs Actual vs Optimal, week by week |
| **Available Players** | Searchable browser over free agents and rostered players |
| **Schedule** | The NFL week with rostered players, owners and custom scores overlaid |
| **Analytics** | Standings, all-play record, schedule luck, power index, volatility and defensive generosity |

### Power rankings

Power is measured in **points per week above a replacement-level roster**, not in
averaged Value Scores. Averaging percentiles was wrong three ways at once, and
the 2026 tight ends show all three:

| | |
|---|---|
| Value Score | 855, 852, 841, 835, 834, 783 |
| Projected PPG | 16.5, 14.8, 13.0, 11.2, 11.1, 8.7 |

- **Percentiles compress the top.** Value Score is a percentile *within* a
  position, so the six best tight ends in the league land in a 21-point band on a
  1000-point scale. The metric genuinely could not tell the best tight end from
  the fifth best.
- **Starting slots were ignored.** This league starts one TE and four LBs.
  Averaging a team's tight ends let a third and fourth TE — players who will
  never enter a lineup — outvote which team owned the best one. That is how a
  team with the #6 TE outranked the team holding **#1**.
- **There was no scarcity.** Twelve points a game from a superflex QB and twelve
  from a kicker are not the same asset, but two 90th percentiles look identical.

So each player is scored by **VORP** — his blended projection minus the
production at his position's startable cliff, in this league's custom scoring —
and a team's positional power is that VORP summed over the slots the league
actually starts, taken from the league's own `roster_positions` with flex slots
split fractionally. Scarcity then needs no multiplier: points are already
comparable across positions, so superflex QB carries two slots over a wide spread
and dominates, while K carries one slot over a nearly flat pool and barely moves.

Outliers can't drag a team down. Depth beyond the starting slots only ever adds —
a decaying insurance premium, floored at zero — so rostering a spare terrible
kicker behind a good one changes nothing at all. A dud only counts when he *is*
the starter, and then only at a discount, since a hole is partly fixable from
waivers. An unfilled slot is charged the same way, so a weak fourth linebacker
still beats no fourth linebacker.

Every row shows the starters it is made of with their league-wide positional
rank, because "who is actually in this number" is the whole answer to why a team
ranks where it does. `npm run verify:power` pins the model against the real 2026
tight end case.

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
npm run verify:projections
```

```bash
npm run verify:power
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

The same workflow refreshes both projection snapshots daily. Run
`npm run refresh:projections` before a local build when you want the latest
source data; the repository snapshots are retained as a fallback if a site is
down, and each source refreshes as its own step so one outage doesn't cost the
other's update.

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
weeks for 30 days, the live week for 2 minutes, and the current season projection
for 6 hours. Recharts is code-split, keeping first paint to ~98KB gzipped.

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
