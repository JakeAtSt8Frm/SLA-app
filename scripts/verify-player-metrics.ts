import assert from 'node:assert/strict';
import { playerMetrics } from '../src/lib/playerMetrics';
import { buildTeamStats } from '../src/lib/teamStats';
import type { Player, StatLine } from '../src/lib/types';

const player: Player = { player_id: '1', position: 'WR', team: 'DAL' };
const weeks = new Map<number, { stats: Record<string, StatLine>; teams: Record<string, string> }>([
  [1, { stats: {
    '1': { rec_tgt: 10, rec_air_yd: 120, rec_yd: 80 },
    '2': { rec_tgt: 10, rec_air_yd: 80, rush_att: 10, rush_yd: 50 },
    '3': { pass_att: 25, pass_cmp: 15, pass_yd: 200, pass_sack: 2 },
    KC: { pass_att: 25, pass_yd: 200, rec_tgt: 20, rec_air_yd: 200 },
  }, teams: { '1': 'KC', '2': 'KC', '3': 'KC', KC: 'KC' } }],
  [2, { stats: {
    '1': { rec_tgt: 5, rec_air_yd: 30, rec_yd: 40 },
    '4': { rec_tgt: 25, rec_air_yd: 170 },
    '5': { rec_tgt: 100, rec_air_yd: 1000 },
  }, teams: { '1': 'BUF', '4': 'BUF', '5': 'KC' } }],
  [3, { stats: { '1': { rec_tgt: 99, rec_air_yd: 999 } }, teams: { '1': 'DAL' } }],
]);
const profile = playerMetrics('1', player, weeks, 2);
const metric = (name: string) => profile.metrics.find((m) => m.label === name)?.value;
assert.equal(profile.games, 2);
assert.equal(metric('Targets / game'), 7.5);
assert.equal(metric('Team target share'), 30, 'target share must include every receiving position and follow trades');
assert.equal(metric('Air-yard share'), 37.5);
assert.equal(metric('aDOT'), 10);
assert.ok(Math.abs(metric('WOPR')! - 0.7125) < 1e-10);
assert.equal(metric('Red-zone targets'), null, 'unreported statistics must stay unknown');
assert.equal(playerMetrics('1', player, new Map(), 1).metrics.find((m) => m.label === 'aDOT')?.value, null);
const noTeam = new Map([[1, { stats: { '1': { rec_tgt: 10 } }, teams: {} }]]);
assert.equal(playerMetrics('1', player, noTeam, 1).metrics.find((m) => m.label === 'Team target share')?.value, null);
const stats = buildTeamStats(weeks, 2);
assert.equal(stats.get('KC')?.passYards, 200, 'exclude duplicate team aggregates');
assert.equal(stats.get('KC')?.rushYards, 50);
assert.equal(stats.get('KC')?.games, 1);
assert.equal(stats.has('BUF'), false, 'pregame statistics must exclude the selected game and later weeks');
assert.equal(buildTeamStats(weeks, 1).size, 0, 'week one has no pregame season sample');
console.log('Player opportunity rates, traded-team denominators, missing data and pregame team stats checks passed.');
