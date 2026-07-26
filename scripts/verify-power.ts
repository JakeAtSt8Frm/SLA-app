/**
 * Regression checks for the forward-looking power model.
 *
 * These tests pin observable rules rather than tuning constants: use the
 * league's exact legal lineup for overall power, count each player once, and
 * use an outlier-resistant whole-room average for positional power.
 */

import assert from 'node:assert/strict';

import {
  buildPowerIndex,
  outlierResistantMean,
  powerIndexOf,
  type PowerPlayerInput,
} from '../src/lib/power';
import type { PositionGroup } from '../src/lib/types';

/** The league's real 2026 lineup. */
const ROSTER_POSITIONS = [
  'QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'K',
  'DL', 'DL', 'DL', 'LB', 'LB', 'LB', 'LB', 'DB', 'DB', 'DB',
  ...Array.from({ length: 20 }, () => 'BN'),
];
const NUM_TEAMS = 6;

function player(
  group: PositionGroup,
  projectedPpg: number | null,
): PowerPlayerInput {
  return { group, projectedPpg, value: null };
}

/* -------------------------------------------------------------------------- */
/* Starting requirements come from the league's own lineup                    */
/* -------------------------------------------------------------------------- */

const empty = buildPowerIndex({
  rosters: [],
  players: new Map(),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(empty.slotsByGroup.get('TE'), 1, 'This league starts one tight end');
assert.equal(empty.slotsByGroup.get('LB'), 4, 'and four linebackers');
assert.equal(
  empty.slotsByGroup.get('QB'),
  2,
  'and projects two quarterbacks because superflex is normally filled by a QB',
);
assert.equal(empty.slotsByGroup.get('K'), 1);

/* -------------------------------------------------------------------------- */
/* Positional scope averages the whole room, not only the starter             */
/* -------------------------------------------------------------------------- */

const TE_ROSTERS: Record<string, Array<[string, number]>> = {
  rbeans26: [['mcbride', 16.5], ['laporta', 11.0], ['otton', 8.5], ['johnson', 6.3]],
  jake: [['bowers', 14.8], ['ferguson', 9.5], ['kraft', 10.6]],
  larv: [['kittle', 13.0], ['kelce', 11.2], ['loveland', 10.8]],
  david: [['fannin', 11.2], ['pitts', 10.3], ['goedert', 10.7]],
  mark: [['warren', 11.1], ['andrews', 9.5], ['schultz', 8.7]],
  sam: [['kincaid', 8.7], ['gadsden', 8.5]],
};

const tePlayers = new Map<string, PowerPlayerInput>();
const teRosters = Object.entries(TE_ROSTERS).map(([, players], index) => {
  for (const [pid, ppg] of players) tePlayers.set(pid, player('TE', ppg));
  return { rosterId: index + 1, playerIds: players.map(([pid]) => pid) };
});
const teamIdByName = new Map(
  Object.keys(TE_ROSTERS).map((name, index) => [name, index + 1] as const),
);

const te = buildPowerIndex({
  rosters: teRosters,
  players: tePlayers,
  rosterPositions: ['TE'],
  numTeams: NUM_TEAMS,
});
const teOrder = [...te.byTeam.values()]
  .sort((a, b) => b.byGroup.TE.score - a.byGroup.TE.score)
  .map((team) => team.rosterId);

assert.equal(teOrder[0], teamIdByName.get('larv'));
assert.equal(teOrder[1], teamIdByName.get('jake'));
assert.equal(teOrder[teOrder.length - 1], teamIdByName.get('sam'));

const rbeansTe = te.byTeam.get(teamIdByName.get('rbeans26')!)!.byGroup.TE;
assert.equal(rbeansTe.starters.length, 1, 'One TE slot means one starter counts');
assert.equal(rbeansTe.starters[0].pid, 'mcbride');
assert.equal(rbeansTe.starters[0].rank, 1);
assert.equal(rbeansTe.depth.length, 3);
assert.equal(
  Number(rbeansTe.score.toFixed(3)),
  10.575,
  'Positional power averages the full room rather than taking only McBride',
);

/* -------------------------------------------------------------------------- */
/* Statistical outliers are removed conservatively                            */
/* -------------------------------------------------------------------------- */

assert.deepEqual(
  outlierResistantMean([40, 10, 10, 10]),
  { average: 10, outliersRemoved: 1 },
  'One isolated high projection must not control the room average',
);
assert.deepEqual(
  outlierResistantMean([20, 18, 17, 1]),
  { average: 55 / 3, outliersRemoved: 1 },
  'One isolated low projection must not sink the room average',
);
assert.deepEqual(
  outlierResistantMean([20, 18, 17]),
  { average: 55 / 3, outliersRemoved: 0 },
  'A three-player room is too small for reliable outlier removal',
);

/* -------------------------------------------------------------------------- */
/* The legal lineup is optimized globally, including flex                     */
/* -------------------------------------------------------------------------- */

const flexible = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['qb1', 'qb2', 'rb1'] }],
  players: new Map<string, PowerPlayerInput>([
    ['qb1', player('QB', 20)],
    ['qb2', player('QB', 18)],
    ['rb1', player('RB', 19)],
  ]),
  rosterPositions: ['QB', 'SUPER_FLEX'],
  numTeams: 1,
});
assert.equal(
  flexible.byTeam.get(1)!.overall,
  39,
  'The solver must choose QB 20 + RB 19, not assume superflex is always QB',
);
assert.deepEqual(
  flexible.byTeam.get(1)!.byGroup.QB.starters.map((entry) => entry.pid),
  ['qb1'],
);
assert.deepEqual(
  flexible.byTeam.get(1)!.byGroup.RB.starters.map((entry) => entry.pid),
  ['rb1'],
);

/* -------------------------------------------------------------------------- */
/* Sleeper duplicate ids cannot fill multiple slots                           */
/* -------------------------------------------------------------------------- */

const duplicated = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['burrow', 'burrow'] }],
  players: new Map<string, PowerPlayerInput>([['burrow', player('QB', 20)]]),
  rosterPositions: ['QB', 'SUPER_FLEX'],
  numTeams: 1,
});
assert.equal(duplicated.byTeam.get(1)!.overall, 20);
assert.equal(duplicated.byTeam.get(1)!.byGroup.QB.starters.length, 1);
assert.equal(duplicated.byTeam.get(1)!.byGroup.QB.unfilledSlots, 1);

/* -------------------------------------------------------------------------- */
/* Missing forecasts are unknown, not invented replacement-level starters     */
/* -------------------------------------------------------------------------- */

const unrated = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['rookie'] }],
  players: new Map<string, PowerPlayerInput>([['rookie', player('DL', null)]]),
  rosterPositions: ['DL'],
  numTeams: 1,
});
assert.equal(unrated.byTeam.get(1)!.overall, 0);
assert.equal(unrated.byTeam.get(1)!.byGroup.DL.starters.length, 0);
assert.equal(unrated.byTeam.get(1)!.byGroup.DL.unfilledSlots, 1);

/* -------------------------------------------------------------------------- */
/* Depth changes positional strength without changing the starting projection */
/* -------------------------------------------------------------------------- */

const depth = buildPowerIndex({
  rosters: [
    { rosterId: 1, playerIds: ['te1', 'deepBackup'] },
    { rosterId: 2, playerIds: ['te2', 'thinBackup'] },
  ],
  players: new Map<string, PowerPlayerInput>([
    ['te1', player('TE', 16)],
    ['deepBackup', player('TE', 14)],
    ['te2', player('TE', 16)],
    ['thinBackup', player('TE', 8)],
  ]),
  rosterPositions: ['TE'],
  numTeams: 2,
});
assert.equal(depth.byTeam.get(1)!.overall, 16);
assert.equal(depth.byTeam.get(2)!.overall, 16);
assert.equal(depth.byTeam.get(1)!.byGroup.TE.score, 15);
assert.equal(depth.byTeam.get(2)!.byGroup.TE.score, 12);

/* -------------------------------------------------------------------------- */
/* Missing positional depth is represented instead of inflating a thin room   */
/* -------------------------------------------------------------------------- */

const thinRoom = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['rb1'] }],
  players: new Map<string, PowerPlayerInput>([['rb1', player('RB', 20)]]),
  rosterPositions: ['RB', 'RB', 'RB'],
  numTeams: 1,
});
assert.equal(
  Number(thinRoom.byTeam.get(1)!.byGroup.RB.score.toFixed(3)),
  6.667,
  'One running back cannot masquerade as a complete three-starter room',
);

/* -------------------------------------------------------------------------- */
/* Overall remains the exact legal projected lineup                           */
/* -------------------------------------------------------------------------- */

const full = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['qb', 'rb', 'wr', 'te'] }],
  players: new Map<string, PowerPlayerInput>([
    ['qb', player('QB', 22)],
    ['rb', player('RB', 17)],
    ['wr', player('WR', 18)],
    ['te', player('TE', 12)],
  ]),
  rosterPositions: ['QB', 'RB', 'WR', 'TE'],
  numTeams: 1,
});
const positionalTotal = (['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'] as PositionGroup[])
  .reduce((sum, group) => sum + full.byTeam.get(1)!.byGroup[group].starterScore, 0);
assert.equal(full.byTeam.get(1)!.overall, 69);
assert.equal(positionalTotal, full.byTeam.get(1)!.overall);

/* -------------------------------------------------------------------------- */
/* Display index                                                               */
/* -------------------------------------------------------------------------- */

assert.equal(powerIndexOf(240, 300), 80);
assert.equal(powerIndexOf(300, 300), 100);
assert.equal(powerIndexOf(-3, 300), 0);
assert.equal(powerIndexOf(0, 0), 0);

console.log('Roster power checks passed.');
