import assert from 'node:assert/strict';
import { isOut } from '../src/data/league';
import { availabilityAdjustedValue, healthStatus, rosterStatus, usesCurrentAvailability } from '../src/lib/availability';
import { parseRosterSnapshot } from '../src/lib/nflContext';
import { parseCsv } from './csv';
import { returnWindow, parseCurrentInjuries, applyCurrentInjuries } from '../src/lib/currentInjuries';
import { enrichPlayer } from '../src/data/selectors';
import type { LeagueData } from '../src/data/league';
import type { Player, NflState } from '../src/lib/types';

const player: Player = { player_id: '1', team: 'KC', status: 'Active' };
assert.equal(isOut({ ...player, status: 'Practice Squad' }), true, 'practice-squad players must not be projected as available');
assert.equal(isOut({ ...player, status: 'Injured Reserve', injury_status: 'Questionable' }), true, 'an injury designation must not hide reserve status');
assert.equal(isOut({ ...player, status: 'Physically Unable to Perform' }), true);
assert.equal(isOut({ ...player, team: null }), true, 'NFL free agents cannot start an NFL game');
assert.equal(isOut(player), false);
assert.equal(isOut({ ...player, injury_status: 'Questionable' }), false);
assert.equal(healthStatus({ ...player, injury_status: 'Q' }), 'questionable');
assert.equal(rosterStatus({ player_id: 'missing' }), 'unknown', 'missing evidence is not free agency');
assert.equal(rosterStatus({ ...player, nflRoster: { status: 'DEV', team: 'KC', week: 1, asOf: '2026-09-10' } }), 'practice-squad');
assert.equal(availabilityAdjustedValue(player, 800, 800), 800);
assert.ok(availabilityAdjustedValue({ ...player, status: 'Practice Squad' }, 800, 800)! < 500);
assert.ok(availabilityAdjustedValue({ ...player, status: 'Injured Reserve' }, 800, 800)! > 500, 'injury absence should retain long-term value');
assert.equal(availabilityAdjustedValue({ ...player, status: 'Retired' }, 800, 800), 0);
assert.equal(availabilityAdjustedValue(player, null, null), null);
const state = { season: '2026', week: 3, season_type: 'regular' } as NflState;
assert.equal(usesCurrentAvailability(state, '2025', 17), false);
assert.equal(usesCurrentAvailability(state, '2026', 2), false);
assert.equal(usesCurrentAvailability(state, '2026', 3), true);
assert.equal(usesCurrentAvailability(state, '2026', 4), false, 'today’s injury designation is not a return timetable');
assert.equal(isOut({ ...player, injury_status: 'Suspended' }), true);
assert.equal(rosterStatus({ ...player, active: false, nflRoster: { status: 'ACT', team: 'KC', week: 1, asOf: '2026-09-10' } }), 'active');
assert.equal(usesCurrentAvailability({ ...state, season_type: 'post' }, '2026', 18), false);
const snapshot = { season: '2026', asOf: '2026-09-10T00:00:00Z', players: { '1': { status: 'DEV', team: 'KC', week: 1 } } };
const now = Date.parse('2026-09-11T00:00:00Z');
assert.ok(parseRosterSnapshot(snapshot, '2026', now));
assert.equal(parseRosterSnapshot(snapshot, '2025', now), null);
assert.equal(parseRosterSnapshot({ ...snapshot, asOf: '2026-09-01' }, '2026', now), null, 'stale roster data must not override current status');
assert.equal(parseRosterSnapshot({ ...snapshot, players: { '1': { status: 9 } } }, '2026', now), null);
assert.deepEqual(parseCsv('a,b\r\n"one,two","three""four"\r\n'), [{ a: 'one,two', b: 'three"four' }]);
const schedule = [
  { home: 'KC', away: 'DEN', date: '2026-09-13' },
  { home: 'BUF', away: 'KC', date: '2026-09-27' },
  { home: 'KC', away: 'LV', date: '2026-10-04' },
];
assert.deepEqual(returnWindow('KC', '2026-09-27', schedule, '2026-09-10'), { gamesBeforeReturn: 1, remainingGames: 3 }, 'byes and return-day games are not missed games');
assert.equal(returnWindow('KC', '2026-09-09', schedule, '2026-09-10').gamesBeforeReturn, null);
assert.equal(returnWindow('KC', null, schedule, '2026-09-10').gamesBeforeReturn, null);
const injurySnapshot = { season: '2026', asOf: '2026-09-10T00:00:00Z', schedule, players: {
  '10': { status: 'Out', injury: 'Knee', returnDate: '2026-09-27', reportedAt: '2026-09-09T12:00:00Z' },
} };
assert.ok(parseCurrentInjuries(injurySnapshot, '2026', now));
assert.equal(parseCurrentInjuries(injurySnapshot, '2025', now), null);
assert.equal(parseCurrentInjuries({ ...injurySnapshot, asOf: '2026-08-01' }, '2026', now), null);
const injuredPlayers = new Map<string, Player>([['1', { ...player, espn_id: 10 }]]);
applyCurrentInjuries(injuredPlayers, injurySnapshot, now);
assert.equal(injuredPlayers.get('1')?.currentInjury?.gamesBeforeReturn, 1);
assert.equal(rosterStatus({ ...injuredPlayers.get('1')!, currentInjury: { ...injuredPlayers.get('1')!.currentInjury!, status: 'Suspension' } }), 'suspended');
assert.equal(healthStatus({ ...injuredPlayers.get('1')!, injury_status: 'Questionable' }), 'out', 'a second source reporting Out must not be hidden by Questionable');
assert.equal(healthStatus({ ...injuredPlayers.get('1')!, injury_status: 'IR', currentInjury: { ...injuredPlayers.get('1')!.currentInjury!, status: 'Questionable' } }), 'out', 'an ESPN Questionable report must not hide Sleeper IR');
assert.ok(availabilityAdjustedValue(injuredPlayers.get('1'), 800, 800)! < 800);
const longAbsence = { ...injuredPlayers.get('1')!, currentInjury: { ...injuredPlayers.get('1')!.currentInjury!, gamesBeforeReturn: 3 } };
assert.ok(availabilityAdjustedValue(longAbsence, 800, 800)! < availabilityAdjustedValue(injuredPlayers.get('1'), 800, 800)!);
const data = {
  season: '2026', nflState: state, weeks: new Map([[3, { stats: {}, projections: { '1': { rec_yd: 100 } }, teams: { '1': 'KC' }, opponents: {} }]]),
  playersById: new Map([['1', { ...player, position: 'WR', status: 'Practice Squad' }]]),
  score: (line: Record<string, number> | undefined) => (line?.rec_yd ?? 0) / 10,
  matchupIndex: { get: () => null }, pregameMatchupIndexes: new Map(), combinedScores: new Map(),
  valueIndex: { seasonTotals: new Map(), byPlayer: new Map(), ppgRanks: new Map(), totalRanks: new Map() },
} as unknown as LeagueData;
assert.equal(enrichPlayer(data, '1', 3, '', false).proj, 0, 'live selectors must suppress ineligible projections');
const historical = { ...data, season: '2025' };
assert.equal(enrichPlayer(historical, '1', 3, '', false).proj, 10, 'today’s practice squad assignment must not erase past projections');
assert.equal(enrichPlayer(historical, '1', 3, '', false).isOut, false);
console.log('NFL availability, valuation, freshness and CSV checks passed.');
