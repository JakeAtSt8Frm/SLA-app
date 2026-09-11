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

// Early-season views use the previous year until four full weeks are complete.
const { buildSeasonMatchupContext, completedMatchupWeeks } = await import('../src/lib/matchupSeason');
const priorWeeks = new Map(Array.from({ length: 18 }, (_, i) => [i + 1, {
  stats: { 'qb-a': { gp: 1, pass_att: 20, pass_yd: 100 } },
  opponents: { 'qb-a': 'D1' },
  teams: { 'qb-a': 'A' },
}]));
const currentWeeks = new Map([...weekStats].map(([week, stats]) => [week, {
  stats, opponents: weekOpponents.get(week)!, teams: weekTeams.get(week)!,
}]));
const contextInput = {
  season: '2026', previousWeeks: priorWeeks, weeks: currentWeeks,
  scoringModel: compileScoring({ pass_yd: 1 }), playersById: players,
};
for (const beforeWeek of [1, 2, 3, 4, 5, 18]) {
  const { index } = buildSeasonMatchupContext({ ...contextInput, completedWeeks: 3, beforeWeek });
  assert.equal(index.season, '2025', 'Even future previews must wait for four completed weeks');
  assert.equal(index.get('QB', 'D1')?.games, 18);
}
const switched = buildSeasonMatchupContext({ ...contextInput, completedWeeks: 4, beforeWeek: 5 });
assert.equal(switched.index.season, '2026');
assert.equal(switched.index.get('QB', 'D1')?.games, 4);
assert.equal(buildSeasonMatchupContext({ ...contextInput, completedWeeks: 18, beforeWeek: 4 }).index.season, '2025',
  'Historical week four must still use last year, without leaking later results');
const emptyCurrent = buildSeasonMatchupContext({ ...contextInput, weeks: new Map(), completedWeeks: 0, beforeWeek: 1 });
assert(emptyCurrent.index.get('QB', 'D1'), 'An empty current season must have matchup ratings');
const numericPrior = new Map([[1, {
  stats: { '123': { gp: 1, pass_yd: 250, pass_att: 30 } },
  opponents: { '123': 'D1' }, teams: { '123': 'A' },
}]]);
assert.equal(buildSeasonMatchupContext({ ...contextInput, previousWeeks: numericPrior, completedWeeks: 0, beforeWeek: 1 })
  .teamStats.get('A')?.passYards, 250, 'Schedule offense averages must use the same prior-season fallback');
const state = { season: '2026', season_type: 'regular', week: 4, leg: 4, display_week: 4, previous_season: '2025', league_season: '2026' };
assert.equal(completedMatchupWeeks('2026', state), 3, 'A live week four is not four completed weeks');
assert.equal(completedMatchupWeeks('2026', { ...state, week: 5 }), 4);
assert.equal(completedMatchupWeeks('2026', { ...state, season_type: 'pre', week: 5 }), 0);
assert.equal(completedMatchupWeeks('2025', state), 18);
console.log('Early-season matchup fallback checks passed.');
