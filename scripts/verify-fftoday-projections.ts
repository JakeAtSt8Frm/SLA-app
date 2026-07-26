import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { blendSeasonProjections } from '../src/data/league';
import {
  matchFftodayProjections,
  parseFftodaySnapshot,
  type FftodaySnapshot,
} from '../src/lib/fftoday';
import type { SeasonProjectionMap } from '../src/lib/dynasty';
import type { Player } from '../src/lib/types';
import {
  parseProjectionPage,
  type PositionConfig,
} from './refresh-fftoday';

const qbPosition: PositionConfig = {
  group: 'QB',
  posId: 10,
  statKeys: [
    'pass_cmp',
    'pass_att',
    'pass_yd',
    'pass_td',
    'pass_int',
    'rush_att',
    'rush_yd',
    'rush_td',
  ],
};
const fixture = `
  <TR>
    <TD>&nbsp;</TD>
    <TD><A HREF="/stats/players/16228/Josh_Allen?LeagueID=193033">Josh Allen</A></TD>
    <TD>BUF</TD><TD>7</TD><TD>326</TD><TD>479</TD><TD>3,787</TD>
    <TD>26</TD><TD>9</TD><TD>113</TD><TD>567</TD><TD>12</TD><TD>384.2</TD>
  </TR>`;
const parsedRows = parseProjectionPage(fixture, qbPosition);
assert.equal(parsedRows.length, 1);
assert.equal(parsedRows[0].name, 'Josh Allen');
assert.equal(parsedRows[0].stats.pass_yd, 3787);
assert.equal(parsedRows[0].stats.rush_td, 12);

const teRows = parseProjectionPage(
  `<TR><TD></TD><TD><A HREF="/stats/players/2/Test_TE">Test TE</A></TD>
   <TD>BUF</TD><TD>7</TD><TD>80</TD><TD>900</TD><TD>8</TD><TD>188</TD></TR>`,
  {
    group: 'TE',
    posId: 40,
    statKeys: ['rec', 'rec_yd', 'rec_td'],
  },
);
assert.equal(
  teRows[0].stats.bonus_rec_te,
  undefined,
  'TE premium must be derived from Sleeper eligibility, not FFToday position',
);

const snapshotPath = new URL('../public/data/fftoday-projections.json', import.meta.url);
const snapshot = parseFftodaySnapshot(
  JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown,
);
assert(snapshot, 'The checked-in FFToday snapshot must be valid');
assert(snapshot.projections.length >= 600, 'The snapshot must contain the full multi-page feed');
for (const group of ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'] as const) {
  assert(
    snapshot.projections.some((projection) => projection.group === group),
    `The snapshot must include ${group}`,
  );
}

const matchingSnapshot: FftodaySnapshot = {
  source: 'FFToday',
  sourceUrl: 'https://example.com',
  season: '2026',
  updatedAt: '7/23/2026',
  fetchedAt: '2026-07-25T00:00:00.000Z',
  projections: [
    {
      fftodayId: '1',
      name: 'D.J. Moore Jr.',
      team: 'CHI',
      group: 'WR',
      stats: { rec: 80 },
    },
  ],
};
const players = new Map<string, Player>([
  [
    'sleeper-1',
    {
      player_id: 'sleeper-1',
      full_name: 'DJ Moore',
      position: 'WR',
      team: 'CHI',
    },
  ],
]);
assert.deepEqual(matchFftodayProjections(matchingSnapshot, players), {
  'sleeper-1': { rec: 80 },
});

const sleeper: SeasonProjectionMap = new Map([
  [
    'player',
    {
      total: 200,
      ppg: 10,
      games: 17,
      usagePerGame: 8,
      sources: [{ name: 'Sleeper', total: 200, ppg: 10 }],
    },
  ],
]);
const fftoday: SeasonProjectionMap = new Map([
  [
    'player',
    {
      total: 300,
      ppg: 20,
      games: 17,
      usagePerGame: 10,
      sources: [
        {
          name: 'FFToday',
          total: 300,
          ppg: 20,
          updatedAt: '7/23/2026',
        },
      ],
    },
  ],
]);
assert.deepEqual(blendSeasonProjections(sleeper, fftoday).get('player'), {
  total: 250,
  ppg: 15,
  games: 17,
  usagePerGame: 9,
  sources: [
    { name: 'Sleeper', total: 200, ppg: 10 },
    { name: 'FFToday', total: 300, ppg: 20, updatedAt: '7/23/2026' },
  ],
});

console.log('FFToday projection import and blend checks passed.');
