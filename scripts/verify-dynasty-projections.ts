import assert from 'node:assert/strict';

import {
  blendProjectedPpg,
  buildDynastyIndex,
  IN_SEASON_PROJECTION_WEIGHT,
  PRESEASON_PROJECTION_WEIGHT,
  type ProjectionSource,
  seasonProjectionWeight,
  type SeasonProjectionMap,
} from '../src/lib/dynasty';
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

console.log('Dynasty season-projection checks passed.');
