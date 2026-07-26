import assert from 'node:assert/strict';
import { compileScoring } from '../src/lib/scoring';
import { buildValueIndex } from '../src/lib/value';
import type { Player, StatLine } from '../src/lib/types';

const pid = 'player';
const playersById = new Map<string, Player>([
  [pid, { player_id: pid, full_name: 'Traded Player', position: 'QB' }],
]);
const weekStats = new Map<number, Record<string, StatLine>>([
  [1, { [pid]: { pass_att: 1, pass_td: 1 } }],
  [2, { [pid]: { pass_att: 1, pass_td: 2 } }],
  [3, { [pid]: { pass_att: 1, pass_td: 1 } }],
]);
const weekProjections = new Map<number, Record<string, StatLine>>([
  [1, { [pid]: { pass_td: 1 } }],
  [2, { [pid]: { pass_td: 1 } }],
  [3, { [pid]: { pass_td: 1 } }],
]);
const weekOpponents = new Map<number, Record<string, string>>([
  [1, { [pid]: 'DEN' }],
  [2, { [pid]: 'NO' }],
  [3, {}],
]);

const valueIndex = buildValueIndex({
  scoringModel: compileScoring({ pass_td: 4 }),
  playersById,
  weekStats,
  weekProjections,
  weekOpponents,
  throughWeek: 3,
});

assert.deepEqual(
  valueIndex.weeklyScores.get(pid)?.map(({ week, opponent }) => ({ week, opponent })),
  [
    { week: 1, opponent: 'DEN' },
    { week: 2, opponent: 'NO' },
    { week: 3, opponent: null },
  ],
  'weekly scores must retain that week’s opponent without a current-team fallback',
);

console.log('Weekly opponent checks passed.');
