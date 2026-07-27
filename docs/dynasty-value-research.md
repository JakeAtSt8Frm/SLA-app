# Dynasty value: historical validation

## Decision

Keep the restored dynasty value model unchanged.

The historical study did not find a replacement formula that improved both
future rank accuracy and identification of future top-quartile assets outside
the seasons used to select its weights. The safer conclusion is that the
restored model is a reasonable baseline, not that another set of hand-tuned
weights should replace it.

## Question and target

The experiment asks:

> Given only what was known at the end of a season, how well can the model rank
> the players who will produce useful fantasy value over the next three years?

Future value is the sum of a player's points above the league's
position-specific replacement level in the next three regular seasons. Points
use all 61 active keys in this league's custom Sleeper scoring. Later seasons
are discounted to keep the target relevant to a dynasty trade made at the
snapshot date.

## Leakage controls

- Features use the snapshot season and at most the two seasons before it.
- Age is reconstructed at each snapshot from birth date; today's age is not
  copied into old observations.
- Formula weights are selected on 2017-2020 only.
- 2021 is validation data.
- 2022, whose outcome spans 2023-2025, is the final untouched holdout.
- Rankings and replacement levels are recalculated within each historical
  season and position.

## Dataset

- 2015-2025 Sleeper weekly stats
- 9,340 end-of-season player snapshots from 2017-2022
- Eight position groups: QB, RB, WR, TE, K, DL, LB, DB
- Minimum four games in the snapshot season
- 100% of included observations have a reconstructed historical age

Run the reproducible study with:

```sh
npm run research:dynasty
```

The first run downloads and aggregates the weekly history. Later runs use the
ignored `.cache` data.

## Results

`rho` is rank correlation, macro-averaged so large IDP pools do not drown out
smaller positions. `Top-25 hit` is the percentage of predicted top-quartile
players who actually finished in the top quartile of future three-year value
over replacement.

| Model | 2021 rho | 2021 top-25 hit | 2022-25 rho | 2022-25 top-25 hit |
| --- | ---: | ---: | ---: | ---: |
| Current-season production | 0.398 | 50.6% | 0.422 | 51.9% |
| Restored 80/20 production blend | 0.398 | **51.2%** | 0.420 | **52.3%** |
| Restored full-model proxy | 0.416 | 48.6% | **0.427** | 49.8% |
| Globally rank-trained candidate | **0.417** | 46.7% | 0.422 | 46.7% |
| Balanced candidate | 0.400 | 49.4% | 0.417 | 50.4% |
| Position-fitted candidate | 0.387 | 49.7% | 0.412 | 51.7% |

The alternatives trade one metric for another and do not produce a stable
out-of-sample improvement. The globally trained formula also regressed from its
training result on both later samples, which is the overfitting pattern this
study was designed to catch.

## What the history supports

- Recent and multi-year production are the strongest stable signals.
- Age adds some three-year ranking information, but its value varies sharply by
  position and cohort.
- Role and availability help in some position-specific fits, but not reliably
  enough to justify new global weights.
- Efficiency and recent trend did not earn stable global weight.
- More formula complexity did not translate to better holdout performance.

## Correction: the buy/sell comparison (not the model)

The study above evaluates the *score*. The buy/sell verdict is a separate
comparison layered on top of it, and it was wrong in a way this study could not
have caught — the study runs with a neutral market input, so it never exercised
the comparison at all.

The verdict ranked the intrinsic opinion over every player in a position group
but the market over only the players FantasyCalc prices. Those pools are far
apart: 68 of 160 tight ends, 107 of 181 running backs, 156 of 284 receivers. The
unpriced remainder sits below every priced player, so a priced player's market
percentile ran 0.20–0.29 under his intrinsic one by construction — wider than the
±0.12 threshold. On the 2025 league that produced Buy for 55.6% of priced players
and Sell for 1.5%, with Buy at 100% in the two cheapest market deciles and 0% in
the two most expensive. The verdict was reporting market cheapness.

Both sides are now ranked over the priced population only. Distribution on the
same data: Buy 11.5%, Fair 46.6%, Sell 7.8%, with Thin market (20.3%) and No read
(13.8%) abstaining where a price or a production record is missing.

**Dynasty scores are unchanged.** The fix touches only the comparison; scores
were checked against a pinned set before and after. `npm run verify:dynasty`
holds the properties, the load-bearing one being that matching ranks read Fair
wherever the player sits in the market.

## Known limits

- Sleeper does not provide historical trade-market prices, so the restored
  model is evaluated with a neutral market input. This is a production forecast,
  not a historical test of FantasyCalc's prices — and, as above, it does not
  exercise the buy/sell comparison either.
- Players without four NFL games at the snapshot are excluded. Rookie and
  prospect valuation still needs market, draft-capital, or college data.
- Historical injury designations are unavailable, so the proxy uses observed
  availability but not the app's current injury-status adjustment.
- The outcome rewards future fantasy production. It does not attempt to
  reconstruct what a player could have been traded for at each old date.

These limits are reasons to leave the market and prospect portions of the
restored model conservative—not reasons to infer unsupported weights.
