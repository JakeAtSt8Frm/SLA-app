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
  surfaces in the player sheet as a **Buy-low / Sell-high / Fair** verdict (see
  [Buy and sell](#buy-and-sell)), alongside contender- and rebuilder-lens
  scores. FantasyCalc doesn't price IDPs, so DL/LB/DB fall back to a
  production-only dynasty valuation with a neutral market leg.

### Buy and sell

The verdict is two percentiles, built the same way over the same population:
where this model ranks a player among the priced players at his position, against
where the market ranks him among that same set.

Ranking them over *different* populations is what the verdict used to do, and it
quietly turned the output into a restatement of "is he cheap". FantasyCalc prices
68 of this league's 160 tight ends, so the market leg was a percentile among 68
while every other leg was a percentile among all 160 — and the 92 unpriced tight
ends sit below every priced one. Measured across the four priced groups, that put
a player's market percentile 0.20–0.29 below his intrinsic one by construction,
which is wider than the calling threshold. Simply having a price read as being
underpriced:

| | Buy | Fair | Sell |
|---|---:|---:|---:|
| Different pools | 55.6% | 42.9% | **1.5%** |
| Same pool | 11.5% | 46.6% | 7.8% |

Under the old comparison the model called Buy on 100% of the cheapest two market
deciles and Sell on six players out of 399. The dynasty scores themselves are
unaffected — this is the comparison, not the model.

Two cases get an explicit abstention rather than a call:

- **Thin market.** FantasyCalc's bottom fifth is rounding noise — values of 4, 15
  and 34 against a 10,275 top — so a percentile gap there measures where a
  worthless player happened to land, not disagreement.
- **No read.** Without production the intrinsic side is a fixed prior rather than
  an opinion, and a prior can only ever open a gap in one direction. Before this
  abstention, 43 of 74 sells were players the model had nothing on: incoming
  rookies the market prices on draft capital, which this model has no source for.
  None of the buys had the same problem. Calling those a sell dresses an absence
  of evidence up as disagreement.

One property is structural rather than a defect: a player already at the top of
his position's market has no headroom to be ranked above it, so the very top
deciles produce no buys. Two percentiles cannot disagree past the end of the
scale.

Both halves show their own "why" breakdown in the player sheet. Every dynasty
input is best-effort: a failed market or prior-season fetch degrades that half
gracefully rather than blocking the app, and a player with only one half carries
that half as his Value Score.

**Matchup Score (0–100)** — an opponent-only next-week rating. It blends
schedule-adjusted custom points allowed (.60) with opportunity volume allowed
(.40). Player and unit strength are deliberately excluded: those describe how
good the player is, not whether the defence provides an advantage. The
Analytics page retains the fuller defence-generosity profile for league-wide
comparison.

The schedule adjustment is a **two-way additive fit** — conceded points modelled
as a league mean plus an offence effect plus a defence effect, solved by
alternating ridge least squares. The obvious alternative, subtracting the
producing team's own average from each week's concession, has a hole: those
offences played different schedules themselves, so an offence inflated by a soft
run drags its victims down with it and a defence that happened to face good
offences stays overrated. Solving both sides jointly lifted holdout rank
correlation from .0147 to .0189, and the shipped `get()` measures .0196 against
2025 residuals.

### The matchup matters far more for some positions than others

Holdout correlation between the chip and a player's miss against his projection:

| QB | K | DL | WR | TE | RB | DB | LB |
|---|---|---|---|---|---|---|---|
| .093 | .058 | .044 | .026 | .016 | .017 | .004 | −.013 |

Facing a soft defence is worth real points to a quarterback and nothing
measurable to a linebacker, whose tackles accrue whether the opponent is good or
bad. The score is never rescaled — rescaling was tried and could not be
justified — but chips for positions below the influence floor are **dimmed and
labelled**, so a column of 21 identical-looking pills doesn't present noise with
the same confidence as signal.

### Tried and rejected

Kept here because negative results are the expensive ones to rediscover. Each
looked good on validation and failed on the 2025 holdout:

- **Per-scoring-category matching** — rating defences separately on sacks,
  tackles, takeaways and so on, matched to a player's own production mix. The
  most promising idea on paper for an IDP league where a sack pays 9 and a tackle
  1.5. Validation .0436, holdout .0156 against .0189 for the simpler blend.
- **Prior-season carryover** — best validation score of anything tested (.0456),
  holdout .0176.
- **Per-position blend weights** — chosen per group on validation, they got
  *worse* on holdout for three of eight positions. The signal is ~.01–.09 on a
  few thousand rows per position, which is not enough to fit eight weight
  vectors without fitting noise.
- **Scaling the chip by position influence** — helped on holdout, hurt on
  validation, both near zero.
- **Points allowed per opportunity** — no signal at all (.0023).

Run `npm run research:matchup` to reproduce all of it.

## Weekly forecasts, as distributions

Every other number here is a point estimate, which is the wrong shape for the
two questions actually asked on a Sunday: *what is my floor* and *can I still
win*. Both need the spread, and the spread can't be asserted — it has to be
measured against what projections have historically done.

So for each position group the app fits the conditional distribution of a real
custom-scored result given its projection, over every projected player-week
already loaded. Three properties are measured rather than assumed:

- **Bias.** Projections aren't centred on the outcome. Correcting that median
  shift is what makes our central estimate better than the projection we started
  from — worth 3.7% of MAE out of sample.
- **Heteroskedasticity.** A 20-point projection is wrong by more points than a
  5-point one, so the scale is fit as a line in the projection level. In 2025
  that runs from `2.4 + 0.44·p` for a TE to `7.5` flat for a QB.
- **Skew.** Fantasy outcomes aren't normal — a floor is bounded near zero while
  a ceiling is a three-touchdown game. Assuming normality would understate every
  ceiling. The shape is carried as the empirical quantiles of the standardised
  residual, so whatever skew and fat-tailedness the real data has survives.

A player who is projected but sometimes doesn't appear carries that too, as a
point mass at zero — counted over the weeks he was *projected for*, never as a
share of season weeks, which would bill every bye twice.

### Per-player bias, and why it's an IDP-only correction

Beyond the group-level shift, individual players are persistently mis-projected —
but only in defensive positions. Correcting for a player's own history against
his projection moves holdout MAE by:

| LB | DB | DL | everyone else |
|---|---|---|---|
| +4.2% | +3.8% | +1.4% | ~0 |

That asymmetry isn't a quirk of the fit, it's a fact about the source. Sleeper
models quarterbacks and skill players carefully, so their residuals are close to
noise and chasing them adds nothing; IDP projections are much cruder, closer to
positional averages, so a linebacker's gap between projection and reality is
real, stable, and never corrected upstream. Positions where the correction
didn't earn its place carry a damping of zero.

Two details that are easy to get wrong and were both got wrong first:

- The correction is an **excess over the player's own position**, referenced to
  the group *mean*. Using his absolute bias double-counts the group shift the
  forecast already applied and pulls every team total ~9% low; referencing the
  group *median* instead hands every player a small positive excess, because
  residuals are right-skewed, and inflates the league ~5%. Averaged over a
  position the correction must come out at zero — it redistributes points
  between players, it doesn't create them. `verify:forecast` asserts this.
- The simulator samples around **projection + shift**, not around the displayed
  median. The median already contains the group's bias and so does the residual
  draw; centring on it applies the same shift twice.

### Verified out of sample

`npm run research:forecast` fits on weeks 1–9 and scores weeks 10–17, so no
evaluation week contributes to the distribution it is judged against. An interval
claiming 80% should contain 80% of outcomes:

```
nominal      10%    25%    50%    75%    90%
actual     11.0%  26.7%  50.9%  76.4%  90.8%    n = 14,200 player-weeks
```

Mean absolute coverage error 1.14 points. Point accuracy over the same held-out
weeks: source projection MAE 4.663, bias-corrected median **4.492**.

`npm run verify:forecast` is the deterministic half — it plants a known bias,
spread and skew in synthetic data and asserts the fit recovers all three.

## Win probability and playoff odds

Team scores are simulated by drawing each starter from his own fitted
distribution. Players who have already finished contribute their real score, so
a week in progress updates as it plays; a week that's over is replayed from
kickoff instead, because "you won" is not a probability.

Each NFL team gets one shared shock per iteration, and players load onto it
through a Gaussian copula — which induces the dependence without disturbing any
of the skewed, heteroskedastic marginals above. This also correctly couples
opposing managers who own players in the same NFL game.

**The measured correlation is near zero** (0.007 in 2024, 0.000 in 2025), which
was not the expected answer. Scores in *levels* are plainly correlated; residuals
around a projection that already prices in the matchup, pace and opponent
largely are not. The copula is kept because it costs nothing and the estimate is
refit each season, but it is currently doing almost no work, and the honest
reading is that independence would be a fine approximation here.

Rest-of-season odds replay the remaining schedule 10,000 times carrying in the
real record, then resolve the bracket under the league's own `playoff_teams` and
`playoff_round_type`. Because it draws from a pool built once per team, it holds
each team's weekly distribution fixed across the remaining schedule — byes,
injuries and waiver moves after the starting week are not modelled.

Team totals land slightly high, by 3.5% in 2025 and 2.5% in 2024, and their 80%
bands are a touch wide (real totals fall outside them 12.8–18.8% of the time
against a nominal 20%). With roughly 47 team-weeks per season those gaps sit
inside sampling noise, but they are the direction of the error.

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
| **Analytics** | Win probability, playoff odds, standings, all-play record, schedule luck, power index, volatility and defensive generosity |

### Power rankings

Overall power is based on the app's **headline Value Scores**, rather than
projected PPG. Each positional rating uses the fixed starter and backup counts
below, then Overall combines those ratings in proportion to starter slots.

The previous experimental VORP model applied a 35% discount to weak starters,
guessed waiver value from the worst rostered player and added a 25% decaying
depth premium. Those constants were not learned from league results, so the
displayed “points above replacement” did not match the math. They have been
removed.

Positional tabs are starter-led Value ratings. The top players receive 85% of
the weight and a fixed number of backups supply the remaining 15%:

| Position | Starters | Bench |
|---|---:|---:|
| QB | 2 | 1 |
| RB | 3 | 2 |
| WR | 4 | 3 |
| TE | 1 | 1 |
| K | 1 | 1 |
| DL | 3 | 2 |
| LB | 4 | 3 |
| DB | 3 | 2 |

Players beyond those limits do not affect positional power. Missing configured
slots count as zero, so a thin room cannot masquerade as a complete one.
`npm run verify:power` checks the exact counts and weights, duplicate Sleeper
ids, missing Value Scores, missing depth and the starter-weighted Overall score.

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
- **Historical matchup scores are pregame-only.** A Week 4 player no longer
  receives a defence rating built with Week 4 and future results.
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
npm run verify:dynasty
```

```bash
npm run verify:forecast
```

```bash
npm run research
```

```bash
npm run research:forecast
```

```bash
npm run research:matchup
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
for 6 hours.

Recharts is code-split, and so is **every page route**. The six pages are not the
same size — Analytics alone carries the Monte Carlo and the bracket resolver,
neither of which someone checking a lineup ever runs — and with a static import
graph all of it is part of the first paint. Splitting at the route cuts the entry
chunk from 40.9KB gzipped to 24.0KB, and moves ~21KB of page code (Analytics,
the player sheet, the chart wrappers, the four other pages) off the critical path
entirely. Landing on Teams now costs 104KB gzipped against 117KB.

The split is otherwise invisible because the nav prefetches: hovering or
tab-focusing a link starts its chunk fetch, so the module is usually parsed
before the tap lands.

Team-week views are memoized for the lifetime of a loaded season, so pages that
share optimal-lineup, history and analytics data reuse the same derived result
instead of rerunning the lineup matcher.

## Failure modes, and what happens in each

A read-only static site can't fix a bad payload, but it can avoid presenting one
as a dead end.

- **A page throws.** Error boundaries wrap the routed page and the app. A page
  that fails leaves the header and tabs standing, so the reader walks to another
  page — which clears the boundary on its own, since the path is its reset key.
  The card offers a retry and a cache drop, because a payload persisted by an
  older build deserializing into an unexpected shape is the likeliest cause and
  would otherwise be re-read on every reload.
- **A deploy lands while a tab is open.** Route chunks are content-hashed and the
  Pages workflow redeploys on a daily cron, so a tab left open overnight holds
  filenames the server no longer has. That surfaces as a failed dynamic import on
  the next tab tapped. It's detected and answered with one automatic reload,
  guarded by a 10-second cooldown so a genuinely broken deploy shows the card
  instead of looping.
- **Sleeper rate-limits.** A season load fires ~40 requests and Sleeper throttles
  bursts during Sunday games, which is exactly when someone opens the app.
  Requests retry three times with exponential backoff and jitter on 429 and 5xx,
  honouring `Retry-After` when it's short enough to be worth waiting out; the
  stats and projections endpoints then fall back to the other host. Permanent
  answers — a 404 on a bracket that doesn't exist yet — are not retried.
- **The same payload is asked for twice.** Cache reads are asynchronous, so two
  callers a few milliseconds apart both miss and both fetch. In-flight requests
  are shared by key, which matters on re-entry: StrictMode double-invokes every
  effect in development, and tapping refresh or flicking between seasons starts a
  second load over the same keys. A shared request that was *aborted* is not
  inherited — the new caller issues its own rather than adopting someone else's
  cancellation.

## Installing it

`manifest.webmanifest` makes the app installable on Android and desktop Chrome,
which read nothing from the Apple meta tags. It ships a maskable icon as well as
the plain one, because Android crops a launcher icon to the platform's own shape
and an icon drawn edge to edge loses its corners.

iOS is still on its own meta tags and, lacking a PNG `apple-touch-icon`, still
falls back to a screenshot for the home-screen icon. A 180×180 PNG is the one
asset left to add by hand.

## A note on the colour scale

Value scores, rank pills and heatmaps use red → yellow → green, matching the
original app. That scale is hard to read with the most common colour-vision
deficiencies, so nothing depends on colour alone: every heatmap cell prints its
value and offers a Table toggle, every chip prints its score, rank pills print
"#11 Total", and boom/bust always ships an arrow icon plus a text label. Chart
lines are the exception and use a CVD-validated categorical pair, since a line
cannot label every point.

## Keyboard and assistive technology

Two things the rest of the app's care about colour didn't cover:

- **The player sheet is a real modal.** `aria-modal` says the page behind is
  inert but does nothing to the tab order, so focus is trapped inside the sheet
  and cycled at its edges. On close it goes back to the row that opened it —
  without that, a keyboard reader restarts at the top of the page every time they
  look a player up, which in a 21-row lineup is the whole interaction.
- **A skip link.** Six nav tabs sit between the top of the document and the
  content on every navigation. The jump is done in JS rather than left to the
  `#main` href: this app routes on the hash, so the fragment navigation would be
  handed to the router as a route and move focus nowhere.
