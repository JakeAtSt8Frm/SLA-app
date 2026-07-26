import assert from 'node:assert/strict';
import { buildRosterWeek } from '../src/data/selectors';
import type { LeagueData, TeamInfo } from '../src/data/league';
import type { Player, Roster } from '../src/lib/types';

const starterSlots = ['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'K', 'DL'];
const starterIds = ['qb', '0', 'wr', 'te', 'sf', 'k', 'dl'];

const roster: Roster = {
  roster_id: 1,
  owner_id: 'owner',
  league_id: 'league',
  players: [...starterIds.filter((pid) => pid !== '0'), 'bench'],
  starters: starterIds,
  settings: {
    wins: 0,
    losses: 0,
    ties: 0,
    fpts: 0,
  },
};

const team: TeamInfo = {
  rosterId: 1,
  name: 'Slot Test',
  ownerName: 'Owner',
  avatar: null,
  wins: 0,
  losses: 0,
  ties: 0,
  pointsFor: 0,
  pointsAgainst: 0,
  roster,
  placement: null,
};

const players: Player[] = [
  { player_id: 'qb', full_name: 'Quarterback', position: 'QB' },
  { player_id: 'wr', full_name: 'Wide Receiver', position: 'WR' },
  { player_id: 'te', full_name: 'Tight End', position: 'TE' },
  { player_id: 'sf', full_name: 'Superflex Quarterback', position: 'QB' },
  { player_id: 'k', full_name: 'Kicker', position: 'K' },
  { player_id: 'dl', full_name: 'Defensive Lineman', position: 'DL' },
  { player_id: 'bench', full_name: 'Bench Running Back', position: 'RB' },
];

/*
 * buildRosterWeek only reads this focused subset. The fixture intentionally
 * crosses the LeagueData boundary here so the assertion exercises the real
 * selector without coupling the test to every unrelated analytics index.
 */
const data = {
  season: '2025',
  rosterSeason: '2026',
  rostersOverridden: true,
  playersById: new Map(players.map((player) => [player.player_id, player])),
  teams: [team],
  teamsById: new Map([[team.rosterId, team]]),
  weeks: new Map([
    [
      1,
      {
        week: 1,
        stats: {},
        projections: {},
        opponents: {},
        teams: {},
        matchups: [],
      },
    ],
  ]),
  starterSlots,
  score: () => 0,
  valueIndex: {
    byPlayer: new Map(),
    seasonTotals: new Map(),
    ppgRanks: new Map(),
    totalRanks: new Map(),
  },
  combinedScores: new Map(),
  matchupIndex: { get: () => null },
  pregameMatchupIndexes: new Map(),
} as unknown as LeagueData;

const rosterWeek = buildRosterWeek(data, team.rosterId, 1);

assert.deepEqual(
  rosterWeek?.starters.map(({ pid, slot }) => ({ pid, slot })),
  [
    { pid: 'qb', slot: 'QB' },
    { pid: 'wr', slot: 'WR' },
    { pid: 'te', slot: 'TE' },
    { pid: 'sf', slot: 'SUPER_FLEX' },
    { pid: 'k', slot: 'K' },
    { pid: 'dl', slot: 'DL' },
  ],
  'empty Sleeper starter placeholders must not shift later players into earlier slots',
);

console.log('Roster slot alignment checks passed.');
