import assert from 'node:assert/strict';

import {
  blendProjectedPpg,
  buildDynastyIndex,
  IN_SEASON_PROJECTION_WEIGHT,
  PRESEASON_PROJECTION_WEIGHT,
  type ProjectionSource,
  seasonProjectionWeight,
  type SeasonProjectionMap,
  verdictFor,
} from '../src/lib/dynasty';
import type { MarketEntry } from '../src/lib/market';
import type { Player } from '../src/lib/types';
import type { ValueIndex } from '../src/lib/value';

assert.equal(seasonProjectionWeight(0), PRESEASON_PROJECTION_WEIGHT);
assert.equal(seasonProjectionWeight(6), IN_SEASON_PROJECTION_WEIGHT);
assert.equal(seasonProjectionWeight(12), IN_SEASON_PROJECTION_WEIGHT);
assert.deepEqual(blendProjectedPpg(20, 30, 0), {
  ppg: 24,
  projectionWeight: 0.4,
});
assert.deepEqual(blendProjectedPpg(20, 30, 6), {
  ppg: 21.5,
  projectionWeight: 0.15,
});
assert.deepEqual(blendProjectedPpg(null, 30, 0), {
  ppg: 30,
  projectionWeight: 1,
});
assert.deepEqual(blendProjectedPpg(20, null, 0), {
  ppg: 20,
  projectionWeight: 0,
});

const emptyValueIndex: ValueIndex = {
  byPlayer: new Map(),
  ppgRanks: new Map(),
  totalRanks: new Map(),
  weeklyScores: new Map(),
  seasonTotals: new Map(),
};
const players = new Map<string, Player>([
  [
    'projected-lb',
    {
      player_id: 'projected-lb',
      full_name: 'Projected Linebacker',
      position: 'LB',
      fantasy_positions: ['LB'],
      age: 24,
    },
  ],
]);
const projections: SeasonProjectionMap = new Map([
  [
    'projected-lb',
    {
      total: 240,
      ppg: 240 / 17,
      games: 17,
      usagePerGame: 6,
      sources: [
        {
          name: 'Sleeper',
          total: 240,
          ppg: 240 / 17,
        } satisfies ProjectionSource,
      ],
    },
  ],
]);

const index = buildDynastyIndex({
  valueIndex: emptyValueIndex,
  playersById: players,
  priorSeasons: [],
  seasonProjections: projections,
  market: new Map(),
  rosterPositions: ['LB'],
  numTeams: 1,
  throughWeek: 0,
});
const projectedLb = index.byPlayer.get('projected-lb');
assert(projectedLb, 'A projected player must enter the dynasty universe without current stats');
assert.equal(projectedLb.breakdown.projectedSeasonPoints, 240);
assert.equal(projectedLb.breakdown.projectionWeight, 1);

/* -------------------------------------------------------------------------- */
/* Buy / sell verdict                                                          */
/* -------------------------------------------------------------------------- */

/*
 * The verdict compares two percentiles built the same way over the same pool.
 * It previously compared an intrinsic percentile taken over every player in the
 * group against a market percentile taken over only the priced ones — and since
 * FantasyCalc prices well under half of some groups, that offset alone exceeded
 * the calling threshold. On 2025 it returned Buy for 100% of the cheapest two
 * deciles and Sell for 6 players out of 399. These pin the properties that
 * prevent it recurring.
 */

const priced: MarketEntry = {
  value: 3000,
  overallRank: 40,
  positionRank: 8,
  trend30Day: 0,
  redraftValue: null,
  adp: null,
  tradeFrequency: null,
};

assert.equal(verdictFor(null, 0.9, 0.2, true), 'No market', 'Unpriced players get no verdict');

// The property the old model violated: agreement reads Fair wherever the player
// sits in the market. A cheap player is not a buy for being cheap.
for (const rank of [0.25, 0.5, 0.75, 0.95]) {
  assert.equal(
    verdictFor(priced, rank, rank, true),
    'Fair',
    `Matching ranks must read Fair at market rank ${rank}, not track market level`,
  );
}

// Symmetric: the same disagreement in either direction is callable. The old
// model could reach Buy far more easily than Sell.
assert.equal(verdictFor(priced, 0.85, 0.55, true), 'Buy');
assert.equal(verdictFor(priced, 0.55, 0.85, true), 'Sell');
assert.equal(
  verdictFor(priced, 0.6, 0.55, true),
  'Fair',
  'A gap inside the threshold is not a call',
);

// Abstentions, and the order they are checked in.
assert.equal(
  verdictFor(priced, 0.95, 0.05, true),
  'Thin market',
  'Bottom-of-market prices are too coarse to disagree with, however wide the gap',
);
assert.equal(
  verdictFor(priced, 0.2, 0.9, false),
  'No read',
  'Without production the intrinsic side is a prior, not an opinion',
);
assert.equal(
  verdictFor(priced, 0.2, 0.05, false),
  'Thin market',
  'An unpriceable market is reported before a missing production read',
);

console.log('Dynasty season-projection and verdict checks passed.');
