/**
 * Imports FFToday's full-season projections.
 *
 * FFToday publishes one paginated HTML table per position with a fixed column
 * order and no header ids, so rows are read positionally against the column
 * list declared here.
 *
 * Kickers are deliberately not imported. FFToday publishes a single made-field-
 * goal total, and this league scores field goals in five distance buckets worth
 * 3 to 5 points each — splitting one total across them would be inventing the
 * distribution rather than importing it. FantasySharks publishes the buckets, so
 * kickers come from there and from Sleeper.
 */

import { fileURLToPath } from 'node:url';

import {
  EXTERNAL_SOURCES,
  type ExternalProjection,
  type ProjectionSnapshot,
} from '../src/lib/projections';
import type { PositionGroup, StatLine } from '../src/lib/types';
import { fetchText, targetSeason, writeSnapshot } from './snapshot';

const LEAGUE_ID = '193033';
const PAGE_SIZE = 50;

export interface PositionConfig {
  group: PositionGroup;
  posId: number;
  statKeys: string[];
}

const IDP_STAT_KEYS = [
  'idp_tkl_solo',
  'idp_tkl_ast',
  'idp_sack',
  'idp_pass_def',
  'idp_int',
  'idp_ff',
  'idp_fum_rec',
];

const POSITIONS: PositionConfig[] = [
  {
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
  },
  {
    group: 'RB',
    posId: 20,
    statKeys: ['rush_att', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td'],
  },
  {
    group: 'WR',
    posId: 30,
    statKeys: ['rec', 'rec_yd', 'rec_td', 'rush_att', 'rush_yd', 'rush_td'],
  },
  {
    group: 'TE',
    posId: 40,
    statKeys: ['rec', 'rec_yd', 'rec_td'],
  },
  { group: 'DL', posId: 50, statKeys: IDP_STAT_KEYS },
  { group: 'LB', posId: 60, statKeys: IDP_STAT_KEYS },
  { group: 'DB', posId: 70, statKeys: IDP_STAT_KEYS },
];

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function textContent(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFromCell(value: string): number {
  const parsed = Number(textContent(value).replace(/[,%]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseProjectionPage(
  html: string,
  position: PositionConfig,
): ExternalProjection[] {
  const rows = html.match(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi) ?? [];
  const projections: ExternalProjection[] = [];

  for (const row of rows) {
    const playerMatch = row.match(
      /\/stats\/players\/(\d+)\/[^"'?]+[^>]*>([^<]+)<\/A>/i,
    );
    if (!playerMatch) continue;

    const cells = [...row.matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map(
      (match) => match[1],
    );
    const expectedCells = position.statKeys.length + 5;
    if (cells.length < expectedCells) continue;

    const stats: StatLine = {};
    position.statKeys.forEach((key, index) => {
      stats[key] = numberFromCell(cells[index + 4]);
    });
    stats.gp = 17;

    projections.push({
      sourceId: playerMatch[1],
      name: textContent(playerMatch[2]),
      team: textContent(cells[2]).toUpperCase(),
      group: position.group,
      stats,
    });
  }

  return projections;
}

function pageUrl(position: PositionConfig, season: string, page: number): string {
  const params = new URLSearchParams({
    Season: season,
    PosID: String(position.posId),
    LeagueID: LEAGUE_ID,
    order_by: 'FFPts',
    sort_order: 'DESC',
    cur_page: String(page),
  });
  return `https://www.fftoday.com/rankings/playerproj.php?${params}`;
}

async function fetchPosition(
  position: PositionConfig,
  season: string,
): Promise<{ projections: ExternalProjection[]; updatedAt: string }> {
  const projections: ExternalProjection[] = [];
  let updatedAt = '';

  for (let page = 0; ; page += 1) {
    const html = await fetchText(pageUrl(position, season, page));
    if (!updatedAt) {
      updatedAt =
        html.match(/Regular Season,\s*Updated:\s*([^<]+)/i)?.[1]?.trim() ?? '';
    }
    const pageRows = parseProjectionPage(html, position);
    projections.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }

  if (projections.length === 0) {
    throw new Error(`FFToday returned no ${position.group} projections`);
  }
  return { projections, updatedAt };
}

async function main(): Promise<void> {
  const season = targetSeason();
  const positionResults = [];
  for (const position of POSITIONS) {
    positionResults.push(await fetchPosition(position, season));
  }

  const updatedDates = new Set(
    positionResults.map((result) => result.updatedAt).filter(Boolean),
  );
  const snapshot: ProjectionSnapshot = {
    source: 'FFToday',
    sourceUrl: EXTERNAL_SOURCES.FFToday.url,
    season,
    updatedAt: [...updatedDates].join(', ') || 'Unknown',
    fetchedAt: new Date().toISOString(),
    projections: positionResults.flatMap((result) => result.projections),
  };

  await writeSnapshot(snapshot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
