/**
 * Imports FantasySharks' full-season projections.
 *
 * FantasySharks is the deepest free IDP forecast published — 750+ defenders
 * against FFToday's 325, with the assisted-tackle, pass-defensed and forced-
 * fumble splits this league scores heavily — and it is the only one of the
 * three sources that projects kickers by field-goal distance, which the league
 * scores in five separate buckets.
 *
 * Its CSV export is per-position and carries a header row, so columns are
 * mapped by name rather than by index: the same `Int` header means interceptions
 * thrown for a quarterback and interceptions caught for a defender, and a
 * position-keyed map keeps that honest.
 */

import { fileURLToPath } from 'node:url';

import type { ProjectionSnapshot, ExternalProjection } from '../src/lib/projections';
import { EXTERNAL_SOURCES } from '../src/lib/projections';
import type { PositionGroup, StatLine } from '../src/lib/types';
import { fetchText, targetSeason, writeSnapshot } from './snapshot';

const BASE_URL = EXTERNAL_SOURCES.FantasySharks.url;

export interface PositionConfig {
  group: PositionGroup;
  /** FantasySharks' own position id. */
  positionId: number;
  /** CSV header label -> league stat key. Unlisted columns are ignored. */
  columns: Record<string, string>;
}

const OFFENSE_SHARED = {
  'Rush Yds': 'rush_yd',
  'Rush TDs': 'rush_td',
  'Fum Lost': 'fum_lost',
} as const;

const RECEIVING_SHARED = {
  Tgt: 'rec_tgt',
  Rec: 'rec',
  'Rec Yds': 'rec_yd',
  'Rec TDs': 'rec_td',
} as const;

/**
 * IDP columns. `Fum` is fumbles *recovered*; `FumFrc` is fumbles forced — the
 * league scores them at 2 and 4 points respectively, so the two must not be
 * transposed.
 */
const IDP_COLUMNS = {
  Tack: 'idp_tkl_solo',
  Asst: 'idp_tkl_ast',
  Scks: 'idp_sack',
  PassDef: 'idp_pass_def',
  Int: 'idp_int',
  FumFrc: 'idp_ff',
  Fum: 'idp_fum_rec',
  DefTD: 'idp_def_td',
} as const;

export const POSITIONS: PositionConfig[] = [
  {
    group: 'QB',
    positionId: 1,
    columns: {
      Att: 'pass_att',
      Comp: 'pass_cmp',
      'Pass Yds': 'pass_yd',
      'Pass TDs': 'pass_td',
      Int: 'pass_int',
      Rush: 'rush_att',
      ...OFFENSE_SHARED,
    },
  },
  {
    group: 'RB',
    positionId: 2,
    columns: { Rush: 'rush_att', ...OFFENSE_SHARED, ...RECEIVING_SHARED },
  },
  { group: 'WR', positionId: 4, columns: { ...OFFENSE_SHARED, ...RECEIVING_SHARED } },
  { group: 'TE', positionId: 5, columns: { ...OFFENSE_SHARED, ...RECEIVING_SHARED } },
  {
    group: 'K',
    positionId: 7,
    columns: {
      XP: 'xpm',
      XPA: 'xpa',
      Att: 'fga',
      '10-19': 'fgm_0_19',
      '20-29': 'fgm_20_29',
      '30-39': 'fgm_30_39',
      '40-49': 'fgm_40_49',
      '50+': 'fgm_50p',
      Miss: 'fgmiss',
    },
  },
  { group: 'DL', positionId: 8, columns: IDP_COLUMNS },
  { group: 'LB', positionId: 9, columns: IDP_COLUMNS },
  { group: 'DB', positionId: 10, columns: IDP_COLUMNS },
];

/** Splits one CSV record, honouring the quoting used around `Last, First`. */
export function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** `Brown, Marquise` -> `Marquise Brown`. Single-token names pass through. */
function displayName(raw: string): string {
  const [last, first] = raw.split(',').map((part) => part.trim());
  return first ? `${first} ${last}` : last;
}

function toNumber(value: string): number {
  const parsed = Number(value.replace(/[,%]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseProjectionCsv(
  csv: string,
  position: PositionConfig,
): ExternalProjection[] {
  const rows = csv.trim().split(/\r?\n/);
  const header = rows.shift();
  if (!header) return [];

  const headerCells = splitCsvRow(header);
  const idIndex = headerCells.indexOf('Player ID');
  const nameIndex = headerCells.indexOf('Player Name');
  const teamIndex = headerCells.indexOf('Team');
  if (idIndex < 0 || nameIndex < 0 || teamIndex < 0) return [];

  // A duplicated header label (WR rows carry two `>= 50yds` columns) is only a
  // problem for columns we actually read, and none of those repeat.
  const statColumns = headerCells
    .map((label, index) => ({ index, key: position.columns[label] }))
    .filter((column): column is { index: number; key: string } => Boolean(column.key));

  const projections: ExternalProjection[] = [];
  for (const row of rows) {
    const cells = splitCsvRow(row);
    if (cells.length < headerCells.length) continue;
    const sourceId = cells[idIndex];
    const name = displayName(cells[nameIndex]);
    if (!sourceId || !name) continue;

    const stats: StatLine = {};
    for (const column of statColumns) stats[column.key] = toNumber(cells[column.index]);

    // Extra points are published as made and attempted; the league also
    // penalises the misses, which is the difference between the two.
    if (position.group === 'K') {
      stats.xpmiss = Math.max(0, (stats.xpa ?? 0) - (stats.xpm ?? 0));
    }
    stats.gp = 17;

    projections.push({
      sourceId,
      name,
      team: cells[teamIndex].toUpperCase(),
      group: position.group,
      stats,
    });
  }

  return projections;
}

/**
 * Resolves the season's "Segment" id.
 *
 * FantasySharks keys every projection period on an opaque incrementing id that
 * changes each year, so it is read from the period dropdown instead of being
 * pinned in source and silently importing the wrong season next July.
 */
export function findSeasonSegment(html: string, season: string): number | null {
  const options = html.matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/gi);
  for (const [, value, label] of options) {
    if (new RegExp(`${season}\\s+NFL Season`, 'i').test(label)) return Number(value);
  }
  return null;
}

/** The site stamps the table with an `MM-DD` refresh date. */
export function findUpdatedAt(html: string): string {
  return html.match(/Last updated\s*([\d-]+)/i)?.[1]?.trim() ?? 'Unknown';
}

function csvUrl(positionId: number, segment: number): string {
  const params = new URLSearchParams({
    csv: '1',
    Segment: String(segment),
    Position: String(positionId),
    scoring: '1',
    League: '-1',
    uid: '4',
  });
  return `${BASE_URL}?${params}`;
}

async function main(): Promise<void> {
  const season = targetSeason();
  const landing = await fetchText(`${BASE_URL}?League=-1&Position=99&scoring=1&uid=4`);
  const segment = findSeasonSegment(landing, season);
  if (segment === null) {
    throw new Error(`FantasySharks has no "${season} NFL Season" projection period yet`);
  }

  const projections: ExternalProjection[] = [];
  for (const position of POSITIONS) {
    const rows = parseProjectionCsv(
      await fetchText(csvUrl(position.positionId, segment)),
      position,
    );
    if (rows.length === 0) {
      throw new Error(`FantasySharks returned no ${position.group} projections`);
    }
    projections.push(...rows);
  }

  const snapshot: ProjectionSnapshot = {
    source: 'FantasySharks',
    sourceUrl: `${BASE_URL}?Segment=${segment}&Position=99&scoring=1&League=-1&uid=4`,
    season,
    updatedAt: findUpdatedAt(landing),
    fetchedAt: new Date().toISOString(),
    projections,
  };

  await writeSnapshot(snapshot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
