import assert from 'node:assert/strict';
import { buildSeasonPowerRankings, type SeasonPowerInput } from '../src/lib/seasonPower';
import { seasonPowerRankings } from '../src/data/seasonPower';
import type { LeagueData, TeamInfo, WeekData } from '../src/data/league';
import type { Player, StatLine } from '../src/lib/types';

/* ---------------- the summing model ---------------- */

const teams: SeasonPowerInput[] = [
  { rosterId: 1, weeks: [
    { week: 1, actual: 100, projected: 999 },
    { week: 2, actual: 200, projected: 999 },
    { week: 3, actual: null, projected: 150 },
  ] },
  { rosterId: 2, weeks: [
    { week: 1, actual: 120, projected: null },
    { week: 2, actual: 120, projected: null },
    { week: 3, actual: null, projected: 100 },
  ] },
];
const ranked = buildSeasonPowerRankings(teams);
assert.deepEqual(ranked.map((row) => row.rosterId), [1, 2], 'the projected season total decides the order');
assert.equal(ranked[0].played, 300);
assert.equal(ranked[0].playedWeeks, 2);
assert.equal(ranked[0].projected, 150);
assert.equal(ranked[0].remainingWeeks, 1);
assert.equal(ranked[0].total, 450, 'played and projected weeks sum into one season total');
assert.equal(ranked[0].perWeek, 150);
assert.equal(ranked[1].total, 340);

assert.equal(
  buildSeasonPowerRankings([{ rosterId: 1, weeks: [{ week: 1, actual: 50, projected: 400 }] }])[0].total,
  50,
  'a played week is settled: its own projection must never be added beside the result',
);
assert.deepEqual(
  buildSeasonPowerRankings([{ rosterId: 1, weeks: [{ week: 1, actual: 0, projected: null }] }])[0],
  { rosterId: 1, rank: 1, playedWeeks: 1, played: 0, remainingWeeks: 0, projected: 0, total: 0, perWeek: 0 },
  'a recorded scoreless week is a result, not missing data',
);
const empty = buildSeasonPowerRankings([
  { rosterId: 1, weeks: [] },
  { rosterId: 2, weeks: [{ week: 1, actual: null, projected: NaN }] },
  { rosterId: 3, weeks: [{ week: 1, actual: null, projected: 10 }] },
]);
assert.equal(empty[0].rosterId, 3, 'a team with any evidence outranks teams with none');
assert.equal(empty[1].total, null);
assert.equal(empty[1].rank, null, 'teams without evidence are unranked');
assert.equal(empty[2].rank, null);
assert.deepEqual(
  buildSeasonPowerRankings([2, 1].map((rosterId) => ({ rosterId, weeks: [{ week: 1, actual: 40, projected: null }] })))
    .map((row) => [row.rosterId, row.rank]),
  [[1, 1], [2, 1]],
  'ties share a rank and break to the lower roster id',
);

/* ---------------- the league wiring ---------------- */

const team: TeamInfo = {
  rosterId: 1, name: 'Test', ownerName: 'Owner', avatar: null, wins: 0, losses: 0, ties: 0,
  pointsFor: 0, pointsAgainst: 0, placement: null,
  roster: { roster_id: 1, owner_id: 'owner', league_id: 'test', players: ['1'], starters: ['1'], settings: { wins: 0, losses: 0, ties: 0, fpts: 0 } },
};
const player: Player = { player_id: '1', position: 'WR', team: 'KC', status: 'Active' };
const weeks = new Map<number, WeekData>([1, 2].map((week) => [week, {
  week, stats: { '1': { rec: 1, rec_yd: 100 } }, projections: { '1': { rec_yd: 200 } },
  opponents: {}, teams: { '1': 'KC' }, matchups: [{ roster_id: 1, matchup_id: 1, points: 10, starters: ['1'], players: ['1'] }],
}]));
// Focused LeagueData fixture exercises the real lineup selector, as in verify:roster.
const data = {
  season: '2026', nflState: { season: '2026', season_type: 'regular', week: 2 }, currentWeek: 2, maxWeek: 2,
  rostersOverridden: false, teams: [team], teamsById: new Map([[1, team]]), weeks,
  futureProjections: new Map<number, Record<string, StatLine>>([[3, { '1': { rec_yd: 300 } }]]),
  playoff: { teams: 4, weekStart: 4, weeksPerRound: 1, regularSeasonWeeks: 3 },
  playersById: new Map([['1', player]]), starterSlots: ['WR'],
  score: (line: StatLine | undefined) => (line?.rec_yd ?? 0) / 10,
  valueIndex: { byPlayer: new Map(), seasonTotals: new Map(), ppgRanks: new Map(), totalRanks: new Map() },
  dynastyIndex: { byPlayer: new Map() },
  combinedScores: new Map([['1', 1000]]), matchupIndex: { get: () => null }, pregameMatchupIndexes: new Map(),
} as unknown as LeagueData;

const live = seasonPowerRankings(data)[0];
assert.equal(live.playedWeeks, 1, 'the unfinished live week is projected, never counted as a result');
assert.equal(live.played, 10);
assert.equal(live.remainingWeeks, 2, 'the live week and the week after it are both still to play');
assert.equal(live.projected, 50, 'each remaining week uses its own projection: 20 for week 2, 30 for week 3');
assert.equal(live.total, 60);

assert.deepEqual(
  seasonPowerRankings({ ...data, combinedScores: new Map([['1', 1]]) }),
  seasonPowerRankings(data),
  'changing player Value must not alter season power',
);
assert.equal(
  seasonPowerRankings({ ...data, playoff: { ...data.playoff, regularSeasonWeeks: 2 } })[0].total,
  30,
  'the regular season ends where the league says it does',
);

// Availability: the discount is applied to weeks still to play, and only there.
const outPlayer = { ...player, status: 'Inactive' as const, injury_status: 'Out' };
const injured = seasonPowerRankings({ ...data, playersById: new Map([['1', outPlayer]]) })[0];
assert.ok(injured.projected < live.projected, 'an unavailable starter must reduce the projected remainder');
assert.equal(injured.played, live.played, 'today’s status cannot rewrite a week already played');

const retired = seasonPowerRankings({
  ...data, playersById: new Map([['1', { ...player, status: 'Retired' as const }]]),
})[0];
assert.equal(retired.projected, 0, 'a retired starter projects nothing');
assert.equal(retired.total, 10, 'the points he already scored still stand');

const noLineup = new Map(weeks);
noLineup.set(1, { ...weeks.get(1)!, matchups: [] });
assert.equal(
  seasonPowerRankings({ ...data, weeks: noLineup })[0].playedWeeks, 0,
  'missing historical lineups cannot be replaced silently with current starters',
);

const noForecast = seasonPowerRankings({ ...data, futureProjections: new Map() })[0];
assert.equal(noForecast.remainingWeeks, 1, 'a week with no projection is not a week projected to score zero');
assert.equal(noForecast.total, 30);

/* ---------------- positional scope ---------------- */

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
  matchups: [firstTeam, secondTeam].map((entry) => ({ roster_id: entry.rosterId, matchup_id: 1, points: 0,
    players: entry.roster.players, starters: entry.roster.starters })),
}]));
const positionalData = { ...data, teams: [firstTeam, secondTeam], teamsById: new Map([[1, firstTeam], [2, secondTeam]]),
  playersById: positions, starterSlots: ['WR', 'RB', 'SUPER_FLEX'], weeks: positionalWeeks,
  futureProjections: new Map(), playoff: { ...data.playoff, regularSeasonWeeks: 2 } } as unknown as LeagueData;

const receivers = seasonPowerRankings(positionalData, 'WR');
assert.deepEqual(receivers.map((row) => row.rosterId), [1, 2], 'positional rankings reorder on that position alone');
assert.equal(receivers[0].played, 20, 'RB, QB and bench WR scoring must not enter starting WR power');
assert.equal(receivers[0].projected, 10, 'the remaining week projects only the starting WR');
assert.equal(seasonPowerRankings(positionalData, 'RB')[0].played, 30);
assert.equal(
  seasonPowerRankings(positionalData, 'QB').find((row) => row.rosterId === 1)?.played, 5,
  'superflex QBs must count as quarterbacks',
);
assert.equal(
  seasonPowerRankings(positionalData, 'K')[0].total, 0,
  'an unfilled position scores and projects zero, the same as it does in a played week',
);

console.log('Season power: season totals, settled weeks, availability, regular-season bounds, positional scoring, ties and Value independence passed.');
