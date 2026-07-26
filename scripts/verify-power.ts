/**
 * Checks the roster power model.
 *
 * The headline case is the one that exposed the old model: at tight end, where
 * this league starts exactly one, the team holding the best tight end in the
 * league must rank first — and must not be overtaken by a team that merely
 * rosters four mediocre ones.
 */

import assert from 'node:assert/strict';

import {
  BELOW_REPLACEMENT_DISCOUNT,
  buildPowerIndex,
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

/* -------------------------------------------------------------------------- */
/* Starting slots come from the league's own lineup                            */
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
  'and two quarterbacks, because superflex is a quarterback slot in practice',
);
assert.equal(empty.slotsByGroup.get('K'), 1);

/* -------------------------------------------------------------------------- */
/* Tight end: one slot, so the best tight end decides it                       */
/* -------------------------------------------------------------------------- */

/**
 * Real 2026 numbers, VORP in points per week against a tight end replacement
 * level of 11.1. rbeans26 holds Trey McBride, the best tight end in the league;
 * david0929 holds four tight ends, none better than replacement.
 */
const TE_ROSTERS: Record<string, Array<[string, number]>> = {
  rbeans26: [['mcbride', 5.4], ['laporta', -0.1], ['otton', -2.6], ['johnson', -4.8]],
  jake: [['bowers', 3.7], ['ferguson', -1.6], ['kraft', -0.5]],
  larv: [['kittle', 2.0], ['kelce', 0.1], ['loveland', -0.3], ['freiermuth', -3.0]],
  david: [['fannin', 0.1], ['pitts', -0.8], ['goedert', -0.4], ['okonkwo', -3.7]],
  mark: [['warren', 0], ['andrews', -1.6], ['schultz', -2.4], ['likely', -4.0]],
  sam: [['kincaid', -2.4], ['gadsden', -2.6]],
};

const tePlayers = new Map<string, PowerPlayerInput>();
const teRosters = Object.entries(TE_ROSTERS).map(([team, players], index) => {
  for (const [pid, vorp] of players) tePlayers.set(pid, { group: 'TE', vorp, value: null });
  return { rosterId: index + 1, playerIds: players.map(([pid]) => pid) };
});
const teamIdByName = new Map(
  Object.keys(TE_ROSTERS).map((name, index) => [name, index + 1] as const),
);

const te = buildPowerIndex({
  rosters: teRosters,
  players: tePlayers,
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});

const teOrder = [...te.byTeam.values()]
  .map((team) => ({ team, score: team.byGroup.TE.score }))
  .sort((a, b) => b.score - a.score)
  .map((row) => row.team.rosterId);

assert.equal(
  teOrder[0],
  teamIdByName.get('rbeans26'),
  'The team with the best tight end must rank first at a one-slot position',
);
assert.equal(teOrder[1], teamIdByName.get('jake'));
assert.equal(teOrder[2], teamIdByName.get('larv'));
assert.equal(
  teOrder[teOrder.length - 1],
  teamIdByName.get('sam'),
  'and the team with no startable tight end must rank last',
);

const rbeansTe = te.byTeam.get(teamIdByName.get('rbeans26')!)!.byGroup.TE;
assert.equal(rbeansTe.starters.length, 1, 'One slot means one starter counts');
assert.equal(rbeansTe.starters[0].pid, 'mcbride');
assert.equal(rbeansTe.starters[0].rank, 1, 'McBride is TE #1 across every roster');
assert.equal(rbeansTe.depth.length, 3);
assert.equal(
  rbeansTe.depthScore,
  0,
  'Three below-replacement backups add nothing, and must not subtract either',
);
assert.equal(rbeansTe.starterScore, 5.4);

/* -------------------------------------------------------------------------- */
/* A single dud cannot drag a team down                                        */
/* -------------------------------------------------------------------------- */

/** Michael Badgley, projected 4.3 against a kicker replacement level of 8.5. */
const BADGLEY: [string, number] = ['badgley', -4.2];

const withDud = buildPowerIndex({
  rosters: [
    { rosterId: 1, playerIds: ['aubrey', 'badgley'] },
    { rosterId: 2, playerIds: ['aubrey2'] },
  ],
  players: new Map<string, PowerPlayerInput>([
    ['aubrey', { group: 'K', vorp: 1.2, value: null }],
    [BADGLEY[0], { group: 'K', vorp: BADGLEY[1], value: null }],
    ['aubrey2', { group: 'K', vorp: 1.2, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(
  withDud.byTeam.get(1)!.byGroup.K.score,
  withDud.byTeam.get(2)!.byGroup.K.score,
  'Rostering an extra terrible kicker behind a good one must change nothing',
);

/** But if the dud is the only kicker, he is the starter and does count. */
const dudOnly = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['badgley'] }],
  players: new Map<string, PowerPlayerInput>([
    ['badgley', { group: 'K', vorp: -4.2, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(
  Number(dudOnly.byTeam.get(1)!.byGroup.K.score.toFixed(3)),
  Number((-4.2 * BELOW_REPLACEMENT_DISCOUNT).toFixed(3)),
  'A below-replacement starter costs a discounted share of his deficit',
);

/* -------------------------------------------------------------------------- */
/* An injured player is listed twice by Sleeper, and must still count once      */
/* -------------------------------------------------------------------------- */

const duplicated = buildPowerIndex({
  // `players` and `reserve` both carry a player on IR.
  rosters: [{ rosterId: 1, playerIds: ['burrow', 'burrow'] }],
  players: new Map<string, PowerPlayerInput>([
    ['burrow', { group: 'QB', vorp: 1.9, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
const duplicatedQb = duplicated.byTeam.get(1)!.byGroup.QB;
assert.equal(
  duplicatedQb.starters.length,
  1,
  'One quarterback cannot fill both superflex slots by being listed twice',
);
assert.equal(duplicatedQb.unfilledSlots, 1);

/* -------------------------------------------------------------------------- */
/* An empty slot is worse than a weak one                                      */
/* -------------------------------------------------------------------------- */

const shortHanded = buildPowerIndex({
  rosters: [
    { rosterId: 1, playerIds: ['lb1', 'lb2', 'lb3', 'lb4weak'] },
    { rosterId: 2, playerIds: ['lb1b', 'lb2b', 'lb3b'] },
    { rosterId: 3, playerIds: ['lb1c', 'lb2c', 'lb3c', 'lbworst'] },
  ],
  players: new Map<string, PowerPlayerInput>([
    ['lb1', { group: 'LB', vorp: 3, value: null }],
    ['lb2', { group: 'LB', vorp: 2, value: null }],
    ['lb3', { group: 'LB', vorp: 1, value: null }],
    ['lb4weak', { group: 'LB', vorp: -1, value: null }],
    ['lb1b', { group: 'LB', vorp: 3, value: null }],
    ['lb2b', { group: 'LB', vorp: 2, value: null }],
    ['lb3b', { group: 'LB', vorp: 1, value: null }],
    ['lb1c', { group: 'LB', vorp: 3, value: null }],
    ['lb2c', { group: 'LB', vorp: 2, value: null }],
    ['lb3c', { group: 'LB', vorp: 1, value: null }],
    ['lbworst', { group: 'LB', vorp: -5, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(shortHanded.byTeam.get(2)!.byGroup.LB.unfilledSlots, 1);
assert(
  shortHanded.byTeam.get(1)!.byGroup.LB.score > shortHanded.byTeam.get(2)!.byGroup.LB.score,
  'A weak fourth linebacker must beat no fourth linebacker at all',
);

/* -------------------------------------------------------------------------- */
/* Scarcity is intrinsic: slots and points, not a bolted-on multiplier         */
/* -------------------------------------------------------------------------- */

const scarcity = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['qb1', 'qb2', 'k1'] }],
  players: new Map<string, PowerPlayerInput>([
    ['qb1', { group: 'QB', vorp: 6, value: null }],
    ['qb2', { group: 'QB', vorp: 4, value: null }],
    ['k1', { group: 'K', vorp: 6, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(
  scarcity.byTeam.get(1)!.byGroup.QB.score,
  10,
  'Superflex starts two quarterbacks, so both count in full',
);
assert.equal(
  scarcity.byTeam.get(1)!.byGroup.K.score,
  6,
  'One kicker slot counts one kicker, however good he is',
);
assert.equal(scarcity.byTeam.get(1)!.overall, 16);

/* -------------------------------------------------------------------------- */
/* Missing VORP is replacement level, never a hole                             */
/* -------------------------------------------------------------------------- */

const unrated = buildPowerIndex({
  rosters: [{ rosterId: 1, playerIds: ['rookie'] }],
  players: new Map<string, PowerPlayerInput>([
    ['rookie', { group: 'DL', vorp: null, value: null }],
  ]),
  rosterPositions: ROSTER_POSITIONS,
  numTeams: NUM_TEAMS,
});
assert.equal(
  unrated.byTeam.get(1)!.byGroup.DL.starters[0].vorp,
  0,
  'A player with no forecast is read as replacement level, not as a negative',
);

/* -------------------------------------------------------------------------- */
/* Indexing                                                                    */
/* -------------------------------------------------------------------------- */

assert.equal(powerIndexOf(12, 24), 50);
assert.equal(powerIndexOf(24, 24), 100);
assert.equal(powerIndexOf(-3, 24), 0, 'A negative roster reads zero, never a negative bar');
assert.equal(powerIndexOf(0, 0), 0);

const groups: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];
for (const group of groups) {
  assert(
    te.byTeam.get(1)!.byGroup[group] !== undefined,
    `Every position group must be present in the breakdown (${group})`,
  );
}

console.log('Roster power checks passed.');
