import assert from 'node:assert/strict';
import { rosterOwnerByPlayer } from '../src/data/selectors';
import type { TeamInfo } from '../src/data/league';
import type { Roster } from '../src/lib/types';

function team(
  rosterId: number,
  name: string,
  players: string[],
  taxi: string[] = [],
  reserve: string[] = [],
): TeamInfo {
  const roster: Roster = {
    roster_id: rosterId,
    owner_id: `owner-${rosterId}`,
    league_id: 'league',
    players,
    starters: [],
    taxi,
    reserve,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0 },
  };

  return {
    rosterId,
    name,
    ownerName: name,
    avatar: null,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    roster,
    placement: null,
  };
}

const owners = rosterOwnerByPlayer([
  team(1, 'JakeAtSt8Frm', ['starter', '0'], ['taxi'], ['reserve']),
  team(2, 'rbeans26', ['other']),
]);

assert.deepEqual(owners.get('starter'), { rosterId: 1, name: 'JakeAtSt8Frm' });
assert.deepEqual(owners.get('taxi'), { rosterId: 1, name: 'JakeAtSt8Frm' });
assert.deepEqual(owners.get('reserve'), { rosterId: 1, name: 'JakeAtSt8Frm' });
assert.deepEqual(owners.get('other'), { rosterId: 2, name: 'rbeans26' });
assert.equal(owners.has('0'), false);

console.log('Player ownership checks passed.');
