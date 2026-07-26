/**
 * Regression checks for leakage-safe, player-facing matchup scores.
 */

import assert from 'node:assert/strict';

import { compileScoring } from '../src/lib/scoring';
import {
  buildMatchupIndex,
  buildPregameMatchupIndexes,
} from '../src/lib/matchup';
import type { Player, StatLine } from '../src/lib/types';

const players = new Map<string, Player>([
  ['qb-a', { player_id: 'qb-a', position: 'QB' }],
  ['qb-b', { player_id: 'qb-b', position: 'QB' }],
]);
const weekStats = new Map<number, Record<string, StatLine>>();
const weekOpponents = new Map<number, Record<string, string>>();
const weekTeams = new Map<number, Record<string, string>>();

for (let week = 1; week <= 4; week++) {
  weekStats.set(week, {
    'qb-a': { gp: 1, pass_att: 20, pass_yd: week * 100 },
    'qb-b': { gp: 1, pass_att: 40, pass_yd: 300 },
  });
  weekOpponents.set(week, { 'qb-a': 'D1', 'qb-b': 'D2' });
  weekTeams.set(week, { 'qb-a': 'A', 'qb-b': 'B' });
}

const matchup = buildMatchupIndex({
  scoringModel: compileScoring({ pass_yd: 1 }),
  playersById: players,
  weekStats,
  weekOpponents,
  weekTeams,
  throughWeek: 4,
});
const d1 = matchup.byGroup.get('QB')?.get('D1');
assert(d1, 'D1 must have a quarterback matchup entry');

const versusD1 = matchup.get('QB', 'D1');
assert(versusD1);
assert.equal(
  versusD1.score,
  Math.round((d1.opponentAdjustedScore * 0.6 + d1.opportunityScore * 0.4) * 10) / 10,
  'Player matchup score must blend opponent-adjusted concessions and opportunity allowed',
);

const pregame = buildPregameMatchupIndexes(
  {
    scoringModel: compileScoring({ pass_yd: 1 }),
    playersById: players,
    weekStats,
    weekOpponents,
    weekTeams,
  },
  4,
);
assert.equal(
  pregame.get(1)?.get('QB', 'D1'),
  null,
  'Week 1 has no prior-season evidence and must not leak its own result',
);
assert.equal(
  pregame.get(2)?.byGroup.get('QB')?.get('D1')?.pointsPerGame,
  100,
  'Week 2 must use Week 1 only',
);
assert.equal(
  pregame.get(3)?.byGroup.get('QB')?.get('D1')?.pointsPerGame,
  150,
  'Week 3 must use Weeks 1–2 only',
);
assert.equal(d1.pointsPerGame, 250, 'The current Analytics index may use the full sample');

console.log('Matchup model checks passed.');
