/**
 * Checks the third-party projection importers and the ensemble blend.
 *
 * These run against fixtures plus the checked-in snapshots, so a source
 * silently changing its column order or dropping a position group fails here
 * rather than quietly degrading every value score.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { blendSeasonProjections, calibrateSeasonProjections } from '../src/data/league';
import {
  EXTERNAL_SOURCE_NAMES,
  matchProjections,
  parseProjectionSnapshot,
  type ProjectionSnapshot,
} from '../src/lib/projections';
import type { SeasonProjectionMap } from '../src/lib/dynasty';
import type { Player, PositionGroup } from '../src/lib/types';
import {
  parseProjectionPage,
  type PositionConfig as FftodayPosition,
} from './refresh-fftoday';
import {
  findSeasonSegment,
  findUpdatedAt,
  parseProjectionCsv,
  splitCsvRow,
  POSITIONS as SHARKS_POSITIONS,
} from './refresh-fantasysharks';
import { snapshotPath } from './snapshot';

/* -------------------------------------------------------------------------- */
/* FFToday: positional HTML table                                              */
/* -------------------------------------------------------------------------- */

const qbPosition: FftodayPosition = {
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
const parsedRows = parseProjectionPage(
  `
  <TR>
    <TD>&nbsp;</TD>
    <TD><A HREF="/stats/players/16228/Josh_Allen?LeagueID=193033">Josh Allen</A></TD>
    <TD>BUF</TD><TD>7</TD><TD>326</TD><TD>479</TD><TD>3,787</TD>
    <TD>26</TD><TD>9</TD><TD>113</TD><TD>567</TD><TD>12</TD><TD>384.2</TD>
  </TR>`,
  qbPosition,
);
assert.equal(parsedRows.length, 1);
assert.equal(parsedRows[0].name, 'Josh Allen');
assert.equal(parsedRows[0].sourceId, '16228');
assert.equal(parsedRows[0].stats.pass_yd, 3787);
assert.equal(parsedRows[0].stats.rush_td, 12);

const teRows = parseProjectionPage(
  `<TR><TD></TD><TD><A HREF="/stats/players/2/Test_TE">Test TE</A></TD>
   <TD>BUF</TD><TD>7</TD><TD>80</TD><TD>900</TD><TD>8</TD><TD>188</TD></TR>`,
  { group: 'TE', posId: 40, statKeys: ['rec', 'rec_yd', 'rec_td'] },
);
assert.equal(
  teRows[0].stats.bonus_rec_te,
  undefined,
  'TE premium must be derived from Sleeper eligibility, not a source position',
);

/* -------------------------------------------------------------------------- */
/* FantasySharks: header-keyed CSV                                             */
/* -------------------------------------------------------------------------- */

assert.deepEqual(
  splitCsvRow('1,13589,"Allen, Josh",BUF,QB,450.0'),
  ['1', '13589', 'Allen, Josh', 'BUF', 'QB', '450.0'],
  'A quoted "Last, First" cell must not be split on its own comma',
);

const sharksQb = parseProjectionCsv(
  [
    'Rank,Player ID,Player Name,Team,Position,Att,Comp,Pass Yds,Pass TDs,Int,Sacked,Rush,Rush Yds,Rush TDs,Fum Lost,Pts',
    '1,13589,"Allen, Josh",BUF,QB,450.0,303.7,3600.0,31.1,8.8,28.0,106.9,514.0,12.8,3.2,421.4',
  ].join('\n'),
  SHARKS_POSITIONS.find((position) => position.group === 'QB')!,
);
assert.equal(sharksQb.length, 1);
assert.equal(sharksQb[0].name, 'Josh Allen', 'Names are published "Last, First"');
assert.equal(sharksQb[0].sourceId, '13589');
assert.equal(sharksQb[0].stats.pass_yd, 3600);
assert.equal(sharksQb[0].stats.pass_int, 8.8, '`Int` is thrown, not caught, for a QB');
assert.equal(sharksQb[0].stats.rush_att, 106.9);
assert.equal(sharksQb[0].stats.idp_int, undefined);

const sharksLb = parseProjectionCsv(
  [
    'Rank,Player ID,Player Name,Team,Position,Tack,Asst,Scks,PassDef,Int,FumFrc,Fum,DefTD,Pts',
    '1,14892,"Brooks, Jordyn",MIA,LB,89.2,78.3,3.4,4.8,0.2,1.2,0.9,0.0,139.0',
  ].join('\n'),
  SHARKS_POSITIONS.find((position) => position.group === 'LB')!,
);
assert.equal(sharksLb[0].stats.idp_tkl_solo, 89.2);
assert.equal(sharksLb[0].stats.idp_tkl_ast, 78.3);
assert.equal(sharksLb[0].stats.idp_int, 0.2, '`Int` is caught, not thrown, for a defender');
assert.equal(sharksLb[0].stats.idp_ff, 1.2, '`FumFrc` is forced fumbles (4 pts)');
assert.equal(sharksLb[0].stats.idp_fum_rec, 0.9, '`Fum` is recovered fumbles (2 pts)');

const sharksK = parseProjectionCsv(
  [
    'Rank,Player ID,Player Name,Team,Position,XP,XPA,FG,Att,10-19,20-29,30-39,40-49,50+,Miss,Pts',
    '1,12860,"Fairbairn, Ka\'imi",HOU,K,30.0,32.2,40.8,46.3,0.0,9.8,11.3,10.8,8.9,5.5,164.7',
  ].join('\n'),
  SHARKS_POSITIONS.find((position) => position.group === 'K')!,
);
assert.equal(sharksK[0].stats.fgm_30_39, 11.3);
assert.equal(sharksK[0].stats.fgm_50p, 8.9);
assert.equal(sharksK[0].stats.fgmiss, 5.5);
assert.equal(
  Number(sharksK[0].stats.xpmiss?.toFixed(1)),
  2.2,
  'Missed extra points are the gap between attempted and made',
);

assert.equal(
  findSeasonSegment('<option value="874" selected>2026 NFL Season</option>', '2026'),
  874,
);
assert.equal(
  findSeasonSegment('<option value="877">2026 Rest of Year</option>', '2026'),
  null,
  'Only the full-season period may be imported',
);
assert.equal(findUpdatedAt('<font size="2" face="Arial"> Last updated 07-25 </font>'), '07-25');

/* -------------------------------------------------------------------------- */
/* The checked-in snapshots                                                    */
/* -------------------------------------------------------------------------- */

const EXPECTED_GROUPS: Record<string, PositionGroup[]> = {
  FFToday: ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'],
  FantasySharks: ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'],
};

/**
 * The only stat keys an importer may emit.
 *
 * A source's own fantasy point total is never imported — every projection is
 * re-scored from raw stats against this league's settings — so an imported key
 * is only worth anything if Sleeper both *names* it that way and reports it in
 * real game logs. A column mapped to a key Sleeper never records would credit a
 * projection with points no player could actually earn, and one mapped to a
 * plausible-looking name Sleeper doesn't use would silently score zero.
 *
 * Every key below was checked against five 2025 game-log weeks. Splitting them
 * by whether the league scores them is what makes an accidental mapping obvious:
 * anything new has to be classified deliberately.
 */
const SCORED_KEYS = new Set([
  'pass_yd', 'pass_td', 'pass_int',
  'rush_yd', 'rush_td',
  'rec', 'rec_yd', 'rec_td',
  'fum_lost',
  'xpm', 'xpmiss', 'fgmiss',
  'fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50p',
  'idp_tkl_solo', 'idp_tkl_ast', 'idp_sack', 'idp_pass_def',
  'idp_int', 'idp_ff', 'idp_fum_rec', 'idp_def_td',
]);

/** Volume the league does not score, carried only to rank role and usage. */
const USAGE_ONLY_KEYS = new Set([
  'gp', 'pass_att', 'pass_cmp', 'rush_att', 'rec_tgt', 'fga', 'xpa',
]);

for (const source of EXTERNAL_SOURCE_NAMES) {
  const snapshot = parseProjectionSnapshot(
    JSON.parse(await readFile(snapshotPath(source), 'utf8')) as unknown,
    source,
  );
  assert(snapshot, `The checked-in ${source} snapshot must be valid`);
  assert(
    snapshot.projections.length >= 600,
    `The ${source} snapshot must contain the full feed, not one page`,
  );
  for (const group of EXPECTED_GROUPS[source]) {
    assert(
      snapshot.projections.some((projection) => projection.group === group),
      `The ${source} snapshot must include ${group}`,
    );
  }

  const emitted = new Set(
    snapshot.projections.flatMap((projection) => Object.keys(projection.stats)),
  );
  for (const key of emitted) {
    assert(
      SCORED_KEYS.has(key) || USAGE_ONLY_KEYS.has(key),
      `${source} emits "${key}", which is neither a league scoring key nor a ` +
        'declared usage key. Sleeper must both name and report a stat for it to ' +
        'be worth importing — classify it above, or drop the column.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Matching to Sleeper ids                                                     */
/* -------------------------------------------------------------------------- */

const matchingSnapshot: ProjectionSnapshot = {
  source: 'FFToday',
  sourceUrl: 'https://example.com',
  season: '2026',
  updatedAt: '7/23/2026',
  fetchedAt: '2026-07-25T00:00:00.000Z',
  projections: [
    { sourceId: '1', name: 'D.J. Moore Jr.', team: 'CHI', group: 'WR', stats: { rec: 80 } },
    // Only the surname, team and position group agree — the sites disagree on
    // the short form of the first name.
    { sourceId: '2', name: 'Kenneth Gainwell', team: 'TBB', group: 'RB', stats: { rec: 30 } },
    // Same surname and group as a real player but on another team: no match is
    // better than the wrong one.
    { sourceId: '3', name: 'Theodore Moore', team: 'DEN', group: 'WR', stats: { rec: 10 } },
  ],
};
const players = new Map<string, Player>([
  ['sleeper-1', { player_id: 'sleeper-1', full_name: 'DJ Moore', position: 'WR', team: 'CHI' }],
  [
    'sleeper-2',
    {
      player_id: 'sleeper-2',
      full_name: 'Ken Gainwell',
      last_name: 'Gainwell',
      position: 'RB',
      team: 'TB',
    },
  ],
]);
assert.deepEqual(matchProjections(matchingSnapshot, players), {
  'sleeper-1': { rec: 80 },
  'sleeper-2': { rec: 30 },
});

/* -------------------------------------------------------------------------- */
/* Ensemble blend                                                              */
/* -------------------------------------------------------------------------- */

const projectionMap = (
  name: 'Sleeper' | 'FFToday' | 'FantasySharks',
  total: number,
  ppg: number,
  usagePerGame: number | null,
): SeasonProjectionMap =>
  new Map([
    ['player', { total, ppg, games: 17, usagePerGame, sources: [{ name, total, ppg }] }],
  ]);

const blended = blendSeasonProjections(
  projectionMap('Sleeper', 200, 10, 8),
  projectionMap('FFToday', 300, 20, 10),
  projectionMap('FantasySharks', 400, 30, null),
);
assert.deepEqual(blended.get('player'), {
  total: 300,
  ppg: 20,
  games: 17,
  usagePerGame: 9,
  sources: [
    { name: 'Sleeper', total: 200, ppg: 10 },
    { name: 'FFToday', total: 300, ppg: 20 },
    { name: 'FantasySharks', total: 400, ppg: 30 },
  ],
});

const lone = blendSeasonProjections(
  new Map(),
  projectionMap('FantasySharks', 120, 8, 4),
  new Map(),
);
assert.deepEqual(
  lone.get('player')?.total,
  120,
  'A player only one source covers keeps that source in full',
);

/* -------------------------------------------------------------------------- */
/* Scale calibration                                                           */
/* -------------------------------------------------------------------------- */

/** A source's view of one position group: `count` players on a `scale` ladder. */
const ladder = (
  name: 'Sleeper' | 'FantasySharks',
  count: number,
  scale: number,
  usageScale: number,
): SeasonProjectionMap => {
  const map: SeasonProjectionMap = new Map();
  for (let i = 0; i < count; i++) {
    const ppg = (count - i) * scale;
    map.set(`wr-${i}`, {
      total: ppg * 17,
      ppg,
      games: 17,
      usagePerGame: (count - i) * usageScale,
      sources: [{ name, total: ppg * 17, ppg }],
    });
  }
  return map;
};

const groupOf = () => 'WR' as const;
const anchors = new Map<PositionGroup, number>([['WR', 24]]);
// The second source rates the same ladder half as high on points and twice as
// high on usage — the shape of the Sleeper/FantasySharks disagreement.
const [wide, narrow] = calibrateSeasonProjections(
  [ladder('FantasySharks', 40, 1, 2), ladder('Sleeper', 40, 0.5, 1)],
  groupOf,
  anchors,
);

const ppgOf = (map: SeasonProjectionMap, pid: string) => map.get(pid)!.ppg;
assert.equal(
  Number(ppgOf(wide, 'wr-0').toFixed(6)),
  Number(ppgOf(narrow, 'wr-0').toFixed(6)),
  'Sources that rank a group identically must agree on level after calibration',
);
assert(
  ppgOf(wide, 'wr-0') > ppgOf(wide, 'wr-1'),
  'Calibration is a positive scalar, so it must not reorder a source',
);
assert.equal(
  Number(wide.get('wr-0')!.usagePerGame!.toFixed(6)),
  Number(narrow.get('wr-0')!.usagePerGame!.toFixed(6)),
  'Usage is calibrated separately: targets and receptions are different units',
);
assert.deepEqual(
  wide.get('wr-0')!.sources,
  ladder('FantasySharks', 40, 1, 2).get('wr-0')!.sources,
  'Per-source totals shown in the player sheet stay as published',
);

const thin = calibrateSeasonProjections(
  [ladder('FantasySharks', 10, 1, 2), ladder('Sleeper', 40, 0.5, 1)],
  groupOf,
  anchors,
);
assert.equal(
  ppgOf(thin[0], 'wr-0'),
  10,
  'A source with fewer players than the anchor band is left alone, not stretched',
);

console.log('Projection import, matching, calibration and blend checks passed.');
