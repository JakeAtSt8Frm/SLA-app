# Player evaluation review — September 2026

The supplied framework is directionally right: eligibility and opportunity must
come before efficiency. Adding every metric to one weighted score would double
count correlated signals and hide gaps in the data. This change fixes availability
first and exposes supported opportunity statistics without claiming an untested
improvement in predictive accuracy.

## Changes implemented

| Area | Behavior |
| --- | --- |
| NFL roster status | Active, practice squad, NFL free agent, reserve, suspended/exempt, inactive, retired, and unknown are distinct. Fantasy ownership is a separate filter. |
| Status source | A dated nflverse roster snapshot supplements Sleeper, joined by Sleeper ID. Missing matches fall back to Sleeper. Snapshots older than 72 hours or from another NFL season are rejected. |
| Live eligibility | Confirmed unavailable players receive zero current-week lineup projection and play probability. Historical projections and results are preserved. Today's designation is not extended to all future weeks. |
| Current injuries | ESPN's current injury snapshot supplies body part, status and estimated return where available, joined by ESPN ID. Sleeper supplies designation and practice fields. No name-only matching. |
| Return impact | Count scheduled team games before the reported return estimate, excluding byes and the return date itself. Display the baseline points exposed to that absence, explicitly as a scenario. Expired estimates are not used. |
| Injury history | Lazy-load 2023–2024 nflverse reports, grouped by season and body part. Counts describe report weeks and Out designations, not separate injuries or confirmed missed games. |
| Opportunity metrics | Targets/game, team target share across all receiving positions, air-yard share, aDOT, WOPR, carry share, red-zone targets/carries, and position-specific volume and efficiency. |
| Schedule | Compare passing/rushing yards and attempts, sacks taken, position-level points allowed, adjusted allowances, last-four allowances, sample size and matchup rating for both teams. Pregame comparisons exclude the selected week and later results. |
| Presentation | Clearer page hierarchy, separate status controls, compact status badges, source dates, injury panels and responsive comparison tables. No additional UI dependencies. |

## Valuation policy and its limits

The underlying in-season and dynasty models remain visible. The headline score is
the average of their availability-adjusted values, with a single available half
used when the other is missing. Current status applies to the current value
assessment even when the selected production season is historical.

These default multipliers are policy choices, **not backtested probabilities**:

| NFL status | In-season | Dynasty |
| --- | ---: | ---: |
| Active / unknown | 1.00 | 1.00 |
| Practice squad | 0.15 | 0.55 |
| NFL free agent | 0.10 | 0.50 |
| Reserve / injury list, no usable return estimate | 0.45 | 0.90 |
| Suspended / exempt | 0.40 | 0.85 |
| Inactive | 0.20 | 0.60 |
| Retired | 0.00 | 0.00 |

Without a dated return estimate, Questionable uses 0.95/0.99, Doubtful 0.80/0.97,
and Out 0.65/0.95. Roster and injury discounts take the lower factor rather than
multiplying the same absence twice. With a usable estimate and an injury/reserve
designation, in-season value uses the fraction of remaining scheduled games on or
after the estimate. Dynasty loses at most 15% for a whole remaining season of
injury absence. Practice-squad/free-agent restrictions still take precedence.

This models lost availability, not permanent loss of talent or rehabilitation.
It assumes full baseline production after the estimate; a clinician-validated
recurrence model and sourced snap restrictions are not available. Players can
be elevated from practice squads; a daily snapshot may lag a game-day transaction.
The current roster and injury snapshots are small static files, refreshed by the
existing daily Pages build, with source freshness checked again in the browser.

## Review of the supplied metric families

| Metric family | Current coverage / next requirement |
| --- | --- |
| Custom fantasy points, PPG, form, floor/ceiling, boom/bust | Existing league-specific scoring and forecast models retained. Forecast “Expected” now displays the unconditional mean, so a zero-play-probability player cannot show a positive expected score. |
| Snaps, playing time, opportunities, trends | Existing snap share and rolling form retained. Missing stats remain unknown. The existing model's opportunity-share signal is within position; the UI now labels that accurately. |
| WR/TE target earning and air yards | Added full-team target share, air-yard share, aDOT and WOPR. Numerators/denominators are summed across observed games and follow historical team assignments after trades. |
| RB usage and scoring opportunity | Added carries/game, team carry share, targets/game and red-zone carries/targets. Inside-5/10 and goal-line weighting need a play-by-play feed. |
| QB volume and efficiency | Added attempts, rushing volume, completion rate, yards/attempt, sack rate and red-zone attempts. EPA/dropback, CPOE, PROE, pressure splits and designed runs need dedicated feeds. |
| xFP, xTD and regression | Existing projections are forecasts, **not** xFP. Build expected points from play location, opportunity type and league scoring before showing FP minus xFP. Do not relabel actual production as expected production. |
| Routes, TPRR, route participation, YPRR | Not in the existing feed. Obtain reliable route counts first; snaps cannot stand in for routes. |
| Tracking and charting | RYOE, YACOE, separation, first-read share, missed tackles, coverage alignment and pressure rates require additional data, sometimes licensed. Do not populate them with box-score proxies under the same names. |
| Team/offensive environment and schedule | Added team volume and pregame opponent comparisons. Neutral pace, OL quality, coaching tendencies, opponent injuries, weather, totals and implied points remain future integrations. |
| IDP | Existing league scoring is essential. Added per-game tackles, assists, sacks, hits and passes defended. Pressures, alignment, coverage/run-defense snaps and green-dot role need a richer feed. An event-based involvement proxy is not pressure probability. |
| Kicker / D-ST / returns | Kicker volume and accuracy exposed where supplied; retain exact league scoring. Avoid synthetic distance buckets, expected field goals or return shares without source data. D/ST is not currently one of the app's ranked position groups. |
| Dynasty, age, scarcity and market | Existing age curves, multi-season production, custom VORP and market comparison retained. Add sourced draft capital, contracts, guarantees and depth-chart competition before changing their weights. |
| Medical availability / recurrence | Current status and return scenarios added. Public report history ends in 2024. Absence of reports is not evidence of health; repeated report weeks are not recurrence events. |

## Highest-value next steps

1. Obtain a current longitudinal injury feed with expected return, practice dates,
   activation/elevation transactions and snap restrictions. Track revisions and
   source timestamps so advice can be reconstructed before kickoff.
2. Add routes and play-by-play opportunity data; derive league-specific xFP/xTD,
   route participation and high-value opportunity shares.
3. Backtest availability multipliers and opportunity-first forecasts on rolling
   time splits. Compare calibration, rank correlation, lineup regret and error
   against the existing projection ensemble. Include IDP separately.
4. Add environment and tracking variables only if their holdout contribution
   exceeds their complexity, cost and data-latency penalties.

## Sources

- [Sleeper API](https://docs.sleeper.com/)
- [nflverse roster status dictionary](https://nflreadr.nflverse.com/articles/dictionary_roster_status.html)
- [nflverse update schedule and injury-data gap](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html)
- [ESPN injury estimates](https://www.espn.com/nfl/injuries)

## Verification

`verify:availability` covers status aliases, conflicting roster/injury flags,
unknown records, retired players, stale snapshots, return scenarios, bye weeks,
and preservation of historical projections. `verify:metrics` covers traded-team
denominators, missing data, WOPR arithmetic, aggregate-row duplication and
pregame leakage. Existing scoring, roster, ownership, weekly-team, forecast,
dynasty, power, matchup and projection checks also pass. Live scoring parity:
4,194 player-weeks compared with Sleeper, zero mismatches.

The production build passed Chromium checks at 1280×1000 and 390×844: independent
NFL/fantasy filters, practice-squad discounts, ESPN return scenarios, historical
reports, keyboard focus and Escape, week-one empty comparisons, week-18 ratings,
IDP selection and horizontal overflow. No application exceptions were recorded.
The week-18 header and keyboard access to the history disclosure were corrected
during these checks. Canceled games are excluded from the schedule and return
scenarios. Lint reports zero errors and six existing Fast Refresh warnings.

The current roster and injury snapshots total 19,811 bytes gzip; historical
reports are 42,003 bytes gzip and are requested only after opening a player sheet.
The main application chunk is 26.28 KB gzip and CSS is 5.42 KB gzip, with no new
runtime dependencies. One local Chromium measurement loaded the player page in
5.93 seconds cold and 3.02 seconds with the existing data cache. These include live
API requests and are observations, not device-independent performance guarantees.
