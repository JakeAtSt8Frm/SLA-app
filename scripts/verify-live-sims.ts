import assert from 'node:assert/strict';
import { buildWeekForecast, type ResidualModel } from '../src/lib/forecast';
import { compileScoring, createScorer } from '../src/lib/scoring';
import { simulateWeek } from '../src/lib/simulate';
import { weekForecasts, weekOdds } from '../src/data/predictions';
import { buildRosterWeek } from '../src/data/selectors';
import type { LeagueData, TeamInfo } from '../src/data/league';
import type { Player } from '../src/lib/types';

const scoringModel = compileScoring({ pass_yd: 1 });
const model: ResidualModel = {
  byGroup: new Map(), teamCorrelation: 0, playsByPlayer: new Map(),
  biasByPlayer: new Map(), throughWeek: 0, totalSamples: 0,
};
const players = new Map<string, Player>([
  ['a', { player_id: 'a', position: 'QB', team: 'A' }],
  ['b', { player_id: 'b', position: 'QB', team: 'B' }],
  ['c', { player_id: 'c', position: 'QB', team: 'C' }],
]);
const projections = { a: { pass_yd: 20 }, b: { pass_yd: 15 } };
const forecasts = buildWeekForecast({ model, scoringModel, playersById: players, projections,
  stats: { c: { gp: 1, pass_yd: -2 } } });
assert.equal(forecasts.get('a')?.mean, 20, 'No current-season history must not discard the app projection');
assert.equal(forecasts.get('c')?.actual, -2, 'Actual-only players must remain in the sim without a projection or fitted model');
const simulation = simulateWeek({ model, teams: [
  { rosterId: 1, starters: [forecasts.get('a')!, forecasts.get('c')!] },
  { rosterId: 2, starters: [forecasts.get('b')!] },
], pairings: [{ matchupId: 1, rosterIds: [1, 2] }], iterations: 100 });
assert.equal(simulation.matchups[0].homeMean, 18);
assert.equal(simulation.matchups[0].awayMean, 15);

const teams = [1, 2].map((rosterId) => ({ rosterId, roster: {
  roster_id: rosterId, starters: [rosterId === 1 ? 'a' : 'b'], players: ['a', 'b', 'c'],
}, name: `Team ${rosterId}` })) as TeamInfo[];
const pairings = [
  { roster_id: 1, matchup_id: 1, starters: ['a'], players: ['a'], points: 0 },
  { roster_id: 2, matchup_id: 1, starters: ['b'], players: ['b'], points: 0 },
];
const data = {
  season: '2026', nflState: { season: '2026', season_type: 'regular', week: 1 },
  scoringModel, score: createScorer(scoringModel), playersById: players, residualModel: model,
  teams, teamsById: new Map(teams.map((team) => [team.rosterId, team])), starterSlots: ['QB'],
  weeks: new Map(), futureMatchups: new Map([[2, pairings]]), futureProjections: new Map([[2, projections]]),
  nflSchedule: [], pregameMatchupIndexes: new Map(), matchupIndex: { get: () => null },
  valueIndex: { seasonTotals: new Map(), byPlayer: new Map(), ppgRanks: new Map(), totalRanks: new Map() },
  combinedScores: new Map(),
} as unknown as LeagueData;
assert.equal(weekForecasts(data, 2).get('a')?.projection, 20);
assert.equal(buildRosterWeek(data, 1, 2)?.projectedTotal, 20, 'Future board and sim must use the same app projection');
assert(weekOdds(data, 2), 'Scheduled future matchups must show sims');
const liveData: LeagueData = { ...data, weeks: new Map([[1, {
  week: 1, stats: { a: { gp: 1, pass_yd: 7 } }, projections,
  opponents: {}, teams: { a: 'A', b: 'B' }, matchups: pairings,
}]]), nflSchedule: [{ week: 1, home: 'A', away: 'C', status: 'in_progress', date: '' }] };
assert.equal(weekForecasts(liveData, 1).get('a')?.actual, 7);
assert.equal(weekForecasts(liveData, 1).get('b')?.actual, null);
assert.equal(weekOdds(liveData, 1)?.matchups[0].homeMean, 7);
assert.equal(weekOdds(liveData, 1)?.matchups[0].awayMean, 15);
const zeroLive: LeagueData = { ...liveData, weeks: new Map([[1, {
  ...liveData.weeks.get(1)!, stats: {},
}]]) };
assert.equal(weekForecasts(zeroLive, 1).get('a')?.actual, 0, 'A live player with no scoring events must lock at zero');
assert.equal(weekForecasts(zeroLive, 1, 'pregame').get('a')?.actual, null);
const finalData: LeagueData = { ...liveData, nflSchedule: [{ week: 1, home: 'A', away: 'B', status: 'complete', date: '' }] };
assert.equal(weekOdds(finalData, 1)?.matchups[0].awayMean, 0, 'Finished scoreless players must not regain their projection');
console.log('Live simulation checks passed.');
