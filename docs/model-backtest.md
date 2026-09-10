# Model backtest — what actually carries the information

Run it with `npm run research:backtest`. The script walks forward through real
seasons: every signal for week *w* is built only from weeks before *w*, and the
residual model is refit on weeks `< w` before each evaluation, so nothing is
scored against an outcome it had already seen.

## How far back the data goes

Two different horizons, because two different things are being measured.

| Scope | Seasons | Why |
| --- | --- | --- |
| Expected score | 2022–2025 | Sleeper keys stats and projections by **NFL season**, not by league, so four seasons are available even though this league did not exist for the first two. The 2024 league supplies the custom scoring throughout, so every season is scored on today's rules. |
| Lineup decisions | 2024–2025 | A lineup needs a roster and legal slots. Sleeper's `previous_league_id` chain ends at 2024 — `previous_league_id` on the 2024 league is `null` — so there is no earlier roster history to recover. |

Four seasons of lineup history do not exist and cannot be reconstructed. The
lineup table below rests on 156 team-weeks.

## Expected score — 46,211 player-weeks

| signal | MAE | RMSE | bias | corr |
| --- | --- | --- | --- | --- |
| projection | 4.55 | 6.60 | −0.44 | 0.550 |
| **corrected** | **4.45** | **6.55** | −0.42 | **0.563** |
| ppg | 4.62 | 6.72 | −0.17 | 0.541 |
| last4 | 4.77 | 6.97 | −0.06 | 0.518 |
| ewma | 4.64 | 6.78 | −0.08 | 0.538 |
| form (0.6·ewma + 0.4·ppg) | 4.61 | 6.72 | −0.12 | 0.544 |

`corrected` is the source projection plus the model's bias shift. It is the best
single signal on every measure, so the bias correction is earning its place —
but the margin is 0.10 points of MAE, about 2%. Nobody should oversell it.

**No form signal beats the raw projection.** Season PPG, last-4 and the weighted
form are all worse, and `last4` is the worst of the six. A projection already
contains the information a four-week average carries, plus opponent, injury and
role news that an average cannot see.

### Where the correction actually works

| | projection | corrected | change |
| --- | --- | --- | --- |
| QB | 5.96 | 5.94 | −0.02 |
| RB | 3.66 | 3.66 | 0.00 |
| WR | 3.71 | 3.72 | +0.01 |
| TE | 3.18 | 3.18 | 0.00 |
| K | 3.73 | 3.73 | 0.00 |
| DL | 5.44 | 5.36 | −0.08 |
| **LB** | 5.41 | **5.17** | **−0.24** |
| **DB** | 4.55 | **4.36** | **−0.19** |

The bias correction is doing **IDP work and essentially nothing else**. On
offence it moves MAE by a hundredth of a point either way; on LB and DB it takes
0.2 off. That is consistent with the source projecting offence carefully and
IDP loosely, and it means the correction's value in this league comes from the
seven IDP starters, not from the skill positions.

### What the signals are worth together

Standardized OLS over all four features at once, in points of outcome per
standard deviation of the feature (n=45,863):

```
projection     2.48  ██████████
ewma           1.71  ███████
ppg            0.88  ████
last4         -0.32  █
```

The projection dominates, but **ewma carries real independent signal** — 1.71
points per SD that the projection does not already contain. That is the useful
finding hiding under the single-signal table: form is a bad predictor *on its
own* and a good *supplement*. `last4` goes slightly negative, meaning that once
ewma and ppg are in the model it contributes nothing and is absorbing noise.

A blend is worth fitting. A form signal used alone is not.

## Lineup decisions — 156 team-weeks, 2024–2025

Each signal picks a legal lineup before the week; that lineup is then scored on
what actually happened. Reported twice, because Sleeper's per-week
`matchup.players` includes taxi and reserve players — an unfiltered pool lets a
model "start" someone the manager was not allowed to start.

| signal | pts/wk | of optimal | vs manager | | pts/wk | of optimal | vs manager |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | *full pool* | | | | *startable only* | | |
| manager | 251.2 | 75.6% | — | | 251.2 | 77.0% | — |
| projection | 282.7 | 85.1% | +31.6 | | 281.3 | 86.2% | +30.2 |
| **corrected** | **283.4** | **85.3%** | **+32.3** | | **282.0** | **86.4%** | **+30.8** |
| ppg | 240.0 | 72.2% | −11.1 | | 241.5 | 74.0% | −9.6 |
| last4 | 236.2 | 71.1% | −15.0 | | 239.2 | 73.3% | −12.0 |
| ewma | 239.5 | 72.1% | −11.7 | | 241.4 | 74.0% | −9.8 |
| form | 239.8 | 72.1% | −11.4 | | 241.2 | 73.9% | −9.9 |
| optimal | 332.4 | 100.0% | | | 326.2 | 100.0% | |

Restricting the pool barely moves anything (+32.3 → +30.8), so the result is not
an artefact of the model starting ineligible players. Taxi and reserve
membership is only known as of today, so the restricted pass approximates that
week's eligibility rather than recording it.

**Starting the projection-ranked lineup would have been worth about 30 points a
week.** Managers captured 77% of their achievable optimal; the corrected
projection captures 86%. In a league where weekly scores run around 250, thirty
points is not a rounding error.

**Form-ranked lineups are worse than the managers' own judgement**, by 10–12
points a week. Whatever managers are doing when they set a lineup, it beats
"start whoever has been hot", and it loses to "start the projection".

The remaining 14 points to optimal is variance no pregame number removes.

## What this says to build

1. **The app has no forward-looking lineup recommendation.** `Optimal Lineup` is
   retrospective — it ranks on `p.act` and reports what a lineup *was* worth.
   The 30-point gap above is the case for a start/sit view that ranks the
   current roster on the corrected projection. This is the largest single
   finding here and it is unbuilt.
2. **Rank on `corrected`, never on form.** Any start/sit ordering should use the
   bias-corrected projection. Recent form belongs in a blend, if anywhere, and
   `last4` should not be a lineup input at all.
3. **The bias correction is an IDP feature.** If it is ever made configurable or
   costly, keep it for DL/LB/DB and drop it for offence, where it does nothing.
4. **A fitted blend is worth trying for the expected-score model** — projection
   plus ewma, with the weights above as a starting point. Single-signal form is
   a dead end; supplementary form is not.

## What this does not establish

- 156 team-weeks is a small sample from a 6-team league. The lineup ordering is
  large enough to be credible; the differences *among* the form signals are not.
- Every number is in this league's custom scoring, with seven IDP starters. None
  of it transfers to a standard-scoring league.
- The backtest scores signals against outcomes. It says nothing about whether
  the forecast's *intervals* are honest — `research:forecast` covers that.
