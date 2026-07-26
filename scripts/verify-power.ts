/**
 * Regression checks for the Value-based roster power model.
 *
 * These tests pin the configured starter/backup counts, the 85/15 weighting,
 * missing-player behavior and starter-count weighting used by Overall.
 */

import assert from 'node:assert/strict';

import {
  buildPowerIndex,
  POSITION_BENCH_WEIGHT,
  POSITION_POWER_COUNTS,
  POSITION_STARTER_WEIGHT,
  positionRoomScore,
  powerIndexOf,
  type PowerPlayerInput,
} from '../src/lib/power';
import { POSITION_GROUPS, type PositionGroup } from '../src/lib/types';

function player(group: PositionGroup, value: number | null): PowerPlayerInput {
  return { group, value };
}

assert.equal(POSITION_STARTER_WEIGHT, 0.85);
assert.equal(POSITION_BENCH_WEIGHT, 0.15);
assert.deepEqual(POSITION_POWER_COUNTS, {
  QB: { starters: 2, bench: 1 },
  RB: { starters: 3, bench: 2 },
  WR: { starters: 4, bench: 3 },
  TE: { starters: 1, bench: 1 },
  K: { starters: 1, bench: 1 },
  DL: { starters: 3, bench: 2 },
  LB: { starters: 4, bench: 3 },
  DB: { starters: 3, bench: 2 },
});

/* -------------------------------------------------------------------------- */
/* Fixed starter and bench windows                                             */
/* -------------------------------------------------------------------------- */

const wrValues = [900, 850, 800, 750, 700, 650, 600];
const wrRoom = positionRoomScore([...wrValues, 50], 'WR');
assert.equal(wrRoom.coreAverage, 825);
assert.equal(wrRoom.benchAverage, 650);
assert.equal(wrRoom.score, 798.75);
assert.equal(
  positionRoomScore(wrValues, 'WR').score,
  wrRoom.score,
  'An eighth WR is outside the configured 4 + 3 window',
);
assert.equal(
  positionRoomScore([1000, 500, 500, 500, 500, 500, 500], 'WR').coreAverage,
  625,
  'An elite player remains in the starter core instead of being discarded as an outlier',
);

/* -------------------------------------------------------------------------- */
/* Bench Value has a limited effect                                            */
/* -------------------------------------------------------------------------- */

const depth = buildPowerIndex({
  rosters: [
    { rosterId: 1, playerIds: ['te1', 'strongBackup'] },
    { rosterId: 2, playerIds: ['te2', 'thinBackup'] },
  ],
  players: new Map<string, PowerPlayerInput>([
    ['te1', player('TE', 900)],
    ['strongBackup', player('TE', 700)],
    ['te2', player('TE', 900)],
    ['thinBackup', player('TE', 300)],
  ]),
});
assert.equal(depth.byTeam.get(1)!.byGroup.TE.coreAverage, 900);
assert.equal(depth.byTeam.get(2)!.byGroup.TE.coreAverage, 900);
assert.equal(depth.byTeam.get(1)!.byGroup.TE.score, 870);
assert.equal(depth.byTeam.get(2)!.byGroup.TE.score, 810);

/* -------------------------------------------------------------------------- */
/* Duplicate ids, missing Value and missing depth                              */
/* -------------------------------------------------------------------------- */

const edgeCases = buildPowerIndex({
  rosters: [{
    rosterId: 1,
    playerIds: ['rb1', 'rb1', 'unrated', 'deep1', 'deep2', 'deep3'],
  }],
  players: new Map<string, PowerPlayerInput>([
    ['rb1', player('RB', 900)],
    ['unrated', player('RB', null)],
    ['deep1', player('RB', 100)],
    ['deep2', player('RB', 90)],
    ['deep3', player('RB', 1)],
  ]),
});
const rb = edgeCases.byTeam.get(1)!.byGroup.RB;
assert.deepEqual(rb.starters.map(({ pid }) => pid), ['rb1', 'deep1', 'deep2']);
assert.deepEqual(rb.depth.map(({ pid }) => pid), ['deep3']);
assert.equal(rb.unfilledSlots, 0);
assert.equal(
  rb.score,
  ((900 + 100 + 90) / 3) * 0.85 + (1 / 2) * 0.15,
);

const thinRoom = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['rb1'] }],
  players: new Map<string, PowerPlayerInput>([['rb1', player('RB', 900)]]),
});
assert.equal(thinRoom.byTeam.get(1)!.byGroup.RB.coreAverage, 300);
assert.equal(thinRoom.byTeam.get(1)!.byGroup.RB.benchAverage, 0);
assert.equal(thinRoom.byTeam.get(1)!.byGroup.RB.score, 255);
assert.equal(thinRoom.byTeam.get(1)!.byGroup.RB.unfilledSlots, 2);

/* -------------------------------------------------------------------------- */
/* Overall weights positional Value by starter count                           */
/* -------------------------------------------------------------------------- */

const completePlayers = new Map<string, PowerPlayerInput>();
const completeIds: string[] = [];
for (const group of POSITION_GROUPS) {
  const counts = POSITION_POWER_COUNTS[group];
  for (let index = 0; index < counts.starters; index += 1) {
    const pid = `${group}-starter-${index}`;
    completeIds.push(pid);
    completePlayers.set(pid, player(group, 800));
  }
  for (let index = 0; index < counts.bench; index += 1) {
    const pid = `${group}-bench-${index}`;
    completeIds.push(pid);
    completePlayers.set(pid, player(group, 600));
  }
}
const complete = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: completeIds }],
  players: completePlayers,
});
assert.equal(
  complete.byTeam.get(1)!.overall,
  770,
  'Equal position scores remain unchanged after starter-count weighting',
);

const weighted = buildPowerIndex({
  rosters: [{
    rosterId: 1,
    playerIds: [
      'qb1', 'qb2', 'qb3',
      'wr1', 'wr2', 'wr3', 'wr4', 'wr5', 'wr6', 'wr7',
    ],
  }],
  players: new Map<string, PowerPlayerInput>([
    ['qb1', player('QB', 1000)],
    ['qb2', player('QB', 1000)],
    ['qb3', player('QB', 1000)],
    ['wr1', player('WR', 500)],
    ['wr2', player('WR', 500)],
    ['wr3', player('WR', 500)],
    ['wr4', player('WR', 500)],
    ['wr5', player('WR', 500)],
    ['wr6', player('WR', 500)],
    ['wr7', player('WR', 500)],
  ]),
});
assert.equal(
  weighted.byTeam.get(1)!.overall,
  (1000 * 2 + 500 * 4) / 21,
  'QB and WR scores contribute according to their configured starter counts',
);

/* -------------------------------------------------------------------------- */
/* League rank and display index                                               */
/* -------------------------------------------------------------------------- */

assert.equal(depth.ladderByGroup.get('TE')![0].pid, 'te1');
assert.equal(depth.ladderByGroup.get('TE')![0].rank, 1);
assert.equal(powerIndexOf(240, 300), 80);
assert.equal(powerIndexOf(300, 300), 100);
assert.equal(powerIndexOf(-3, 300), 0);
assert.equal(powerIndexOf(0, 0), 0);

console.log('Roster power checks passed.');
