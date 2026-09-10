import assert from 'node:assert/strict';
import { buildSeasonPowerRankings, type SeasonPowerInput } from '../src/lib/seasonPower';
import { seasonPowerRankings } from '../src/data/seasonPower';
import type { LeagueData, TeamInfo, WeekData } from '../src/data/league';
import type { Player, StatLine } from '../src/lib/types';

const teams: SeasonPowerInput[] = [
  { rosterId: 1, weeks: [
    { week: 1, actual: 100, projected: 200 },
    { week: 2, actual: 200, projected: 200 },
    { week: 3, actual: 9999, projected: 100 },
    { week: 4, actual: 9999, projected: 9999 },
  ] },
  { rosterId: 2, weeks: [
    { week: 1, actual: 120, projected: 100 },
    { week: 2, actual: 120, projected: 100 },
    { week: 3, actual: 0, projected: 250 },
  ] },
];
const rankings = buildSeasonPowerRankings(teams, 3);
assert.deepEqual(rankings.map((row) => row.rosterId), [2, 1], 'a stronger weekly projection can overcome weaker season scoring');
assert.equal(rankings[1].score, 137.5);
assert.equal(rankings[1].games, 2, 'selected-week and future actuals cannot affect entering-week power');
assert.deepEqual(buildSeasonPowerRankings(teams, 1).map((row) => row.score), [200, 100], 'week one uses only projections');
assert.deepEqual(buildSeasonPowerRankings(teams.map((team) => ({
  ...team, weeks: team.weeks.filter((row) => row.week < 3).concat({ week: 3, actual: null, projected: null }),
})), 3).map((row) => row.rosterId), [1, 2], 'missing projections leave the ranking based on observed scoring');

const recent = buildSeasonPowerRankings([{ rosterId: 1, weeks: [5, 2, 4, 1, 3].map((week) => ({ week, actual: week * 10, projected: null })) }], 6)[0];
assert.equal(recent.average, 30);
assert.equal(recent.recentAverage, 35, 'last four must be chronological, independent of fetch completion order');
const missing = buildSeasonPowerRankings([
  { rosterId: 1, weeks: [{ week: 1, actual: null, projected: 0 }] },
  { rosterId: 2, weeks: [{ week: 1, actual: null, projected: null }] },
  { rosterId: 3, weeks: [{ week: 1, actual: null, projected: NaN }] },
], 1);
assert.equal(missing[0].score, 0, 'a usable zero projection must remain zero');
assert.equal(missing[0].rank, 1);
assert.equal(missing[1].score, null);
assert.equal(missing[1].rank, null, 'teams without evidence are unranked');
assert.equal(missing[2].score, null);
assert.deepEqual(buildSeasonPowerRankings([2, 1].map((rosterId) => ({ rosterId, weeks: [{ week: 1, actual: 0, projected: null }] })), 2)
  .map((row) => [row.rosterId, row.rank, row.average]), [[1, 1, 0], [2, 1, 0]], 'ties share rank and recorded scoreless weeks count');

const team: TeamInfo = {
  rosterId: 1, name: 'Test', ownerName: 'Owner', avatar: null, wins: 0, losses: 0, ties: 0,
  pointsFor: 0, pointsAgainst: 0, placement: null,
  roster: { roster_id: 1, owner_id: 'owner', league_id: 'test', players: ['1'], starters: ['1'], settings: { wins: 0, losses: 0, ties: 0, fpts: 0 } },
};
const player: Player = { player_id: '1', position: 'WR', team: 'KC', status: 'Active' };
const weeks = new Map<number, WeekData>([1, 2, 3].map((week) => [week, {
  week, stats: { '1': { rec: 1, rec_yd: 100 } }, projections: { '1': { rec_yd: 200 } },
  opponents: {}, teams: { '1': 'KC' }, matchups: [{ roster_id: 1, matchup_id: 1, points: 10, starters: ['1'], players: ['1'] }],
}]));
// Focused LeagueData fixture exercises the real lineup selector, as in verify:roster.
const data = {
  season: '2026', nflState: { season: '2026', season_type: 'regular', week: 2 }, currentWeek: 2,
  rostersOverridden: false, teams: [team], teamsById: new Map([[1, team]]), weeks,
  playersById: new Map([['1', player]]), starterSlots: ['WR'],
  score: (line: StatLine | undefined) => (line?.rec_yd ?? 0) / 10,
  valueIndex: { byPlayer: new Map(), seasonTotals: new Map(), ppgRanks: new Map(), totalRanks: new Map() },
  combinedScores: new Map([['1', 1000]]), matchupIndex: { get: () => null }, pregameMatchupIndexes: new Map(),
} as unknown as LeagueData;
assert.equal(seasonPowerRankings(data, 3)[0].games, 1, 'an unfinished live week must not depress season averages');
assert.equal(seasonPowerRankings(data, 2)[0].projection, 20);
assert.deepEqual(seasonPowerRankings({ ...data, combinedScores: new Map([['1', 1]]) }, 2), seasonPowerRankings(data, 2), 'changing player Value must not alter season power');
const noLiveStats = new Map(weeks);
noLiveStats.set(2, { ...weeks.get(2)!, stats: {} });
const practiceSquad = { ...data, weeks: noLiveStats, playersById: new Map([['1', { ...player, status: 'Practice Squad' }]]) };
assert.equal(seasonPowerRankings(practiceSquad, 2)[0].projection, 0, 'live NFL ineligibility must suppress the starting-lineup forecast');
assert.equal(seasonPowerRankings({ ...practiceSquad, season: '2025' }, 2)[0].projection, 20, 'today’s ineligibility cannot rewrite a historical projection');
const noLineup = new Map(weeks);
noLineup.set(1, { ...weeks.get(1)!, matchups: [] });
assert.equal(seasonPowerRankings({ ...data, weeks: noLineup }, 2)[0].games, 0, 'missing historical lineups cannot be replaced silently with current starters');
assert.equal(seasonPowerRankings({ ...data, weeks: noLineup, rostersOverridden: true }, 2)[0].games, 1, 'explicit roster overrides retain replay behavior');
const noProjection = new Map(weeks);
noProjection.set(2, { ...weeks.get(2)!, projections: {} });
assert.equal(seasonPowerRankings({ ...data, weeks: noProjection }, 2)[0].projection, null, 'absent forecast data is not a zero-point forecast');

const secondTeam: TeamInfo = { ...team, rosterId: 2, roster: { ...team.roster, roster_id: 2, players: ['5', '6', '7'], starters: ['5', '6', '7'] } };
const firstTeam: TeamInfo = { ...team, roster: { ...team.roster, players: ['1', '2', '3', '4'], starters: ['1', '2', '3'] } };
const positions = new Map<string, Player>([
  ['1', { ...player, position: 'WR' }], ['2', { ...player, player_id: '2', position: 'RB' }],
  ['3', { ...player, player_id: '3', position: 'QB' }], ['4', { ...player, player_id: '4', position: 'WR' }],
  ['5', { ...player, player_id: '5', position: 'WR' }], ['6', { ...player, player_id: '6', position: 'RB' }],
  ['7', { ...player, player_id: '7', position: 'QB' }],
]);
const groupStats = { '1': { rec: 1, rec_yd: 200 }, '2': { rec: 1, rec_yd: 100 }, '3': { rec: 1, rec_yd: 50 }, '4': { rec: 1, rec_yd: 10000 },
  '5': { rec: 1, rec_yd: 50 }, '6': { rec: 1, rec_yd: 300 }, '7': { rec: 1, rec_yd: 100 } };
const groupProjections = { '1': { rec_yd: 100 }, '2': { rec_yd: 50 }, '3': { rec_yd: 200 }, '4': { rec_yd: 10000 },
  '5': { rec_yd: 50 }, '6': { rec_yd: 400 }, '7': { rec_yd: 200 } };
const positionalWeeks = new Map<number, WeekData>([1, 2].map((week) => [week, {
  week, stats: week === 1 ? groupStats : {}, projections: groupProjections, opponents: {}, teams: {},
  matchups: [firstTeam, secondTeam].map((team) => ({ roster_id: team.rosterId, matchup_id: 1, points: 0,
    players: team.roster.players, starters: team.roster.starters })),
}]));
const positionalData = { ...data, teams: [firstTeam, secondTeam], teamsById: new Map([[1, firstTeam], [2, secondTeam]]),
  playersById: positions, starterSlots: ['WR', 'RB', 'SUPER_FLEX'], weeks: positionalWeeks };
assert.deepEqual(seasonPowerRankings(positionalData, 2).map((row) => row.rosterId), [2, 1]);
const receivers = seasonPowerRankings(positionalData, 2, 'WR');
assert.deepEqual(receivers.map((row) => row.rosterId), [1, 2], 'positional rankings must reorder on position scoring, not overall strength');
assert.equal(receivers[0].score, 17.5, 'RB, QB and bench WR scoring must not enter starting WR power');
assert.equal(seasonPowerRankings(positionalData, 2, 'RB')[0].score, 32.5);
assert.equal(seasonPowerRankings(positionalData, 2, 'QB').find((row) => row.rosterId === 1)?.score, 8.75, 'superflex QBs must count as quarterbacks');
assert.equal(seasonPowerRankings(positionalData, 2, 'K')[0].score, 0, 'an empty position is zero when the lineup and projections are known');
assert.equal(seasonPowerRankings(positionalData, 1, 'WR')[0].score, 10, 'positional week-one power uses only that position’s projection');
const noReceiverProjection = new Map(positionalWeeks);
noReceiverProjection.set(2, { ...positionalWeeks.get(2)!, projections: { '2': { rec_yd: 50 } } });
assert.equal(seasonPowerRankings({ ...positionalData, weeks: noReceiverProjection }, 2, 'WR')[0].projection, null, 'another position’s projection cannot stand in for a missing positional forecast');

console.log('Season power: chronology, positional scoring, flex slots, projections, missing data, ties, live availability and Value independence passed.');
