import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FFTODAY_SOURCE_URL,
  type FftodayProjection,
  type FftodaySnapshot,
} from '../src/lib/fftoday';
import type { PositionGroup, StatLine } from '../src/lib/types';

const LEAGUE_ID = '193033';
const PAGE_SIZE = 50;
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../public/data/fftoday-projections.json',
);

export interface PositionConfig {
  group: PositionGroup;
  posId: number;
  statKeys: string[];
}

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
  {
    group: 'DL',
    posId: 50,
    statKeys: [
      'idp_tkl_solo',
      'idp_tkl_ast',
      'idp_sack',
      'idp_pass_def',
      'idp_int',
      'idp_ff',
      'idp_fum_rec',
    ],
  },
  {
    group: 'LB',
    posId: 60,
    statKeys: [
      'idp_tkl_solo',
      'idp_tkl_ast',
      'idp_sack',
      'idp_pass_def',
      'idp_int',
      'idp_ff',
      'idp_fum_rec',
    ],
  },
  {
    group: 'DB',
    posId: 70,
    statKeys: [
      'idp_tkl_solo',
      'idp_tkl_ast',
      'idp_sack',
      'idp_pass_def',
      'idp_int',
      'idp_ff',
      'idp_fum_rec',
    ],
  },
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
): FftodayProjection[] {
  const rows = html.match(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi) ?? [];
  const projections: FftodayProjection[] = [];

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
      fftodayId: playerMatch[1],
      name: textContent(playerMatch[2]),
      team: textContent(cells[2]).toUpperCase(),
      group: position.group,
      stats,
    });
  }

  return projections;
}

function pageUrl(position: PositionConfig, page: number): string {
  const params = new URLSearchParams({
    Season: String(new Date().getUTCFullYear()),
    PosID: String(position.posId),
    LeagueID: LEAGUE_ID,
    order_by: 'FFPts',
    sort_order: 'DESC',
    cur_page: String(page),
  });
  return `https://www.fftoday.com/rankings/playerproj.php?${params}`;
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'SLA-app projection importer (+https://github.com/JakeAtSt8Frm/SLA-app)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`FFToday request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchPosition(position: PositionConfig): Promise<{
  projections: FftodayProjection[];
  updatedAt: string;
}> {
  const projections: FftodayProjection[] = [];
  let updatedAt = '';

  for (let page = 0; ; page += 1) {
    const html = await fetchPage(pageUrl(position, page));
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
  const positionResults = [];
  for (const position of POSITIONS) {
    positionResults.push(await fetchPosition(position));
  }

  const updatedDates = new Set(positionResults.map((result) => result.updatedAt).filter(Boolean));
  const snapshot: FftodaySnapshot = {
    source: 'FFToday',
    sourceUrl: FFTODAY_SOURCE_URL,
    season: String(new Date().getUTCFullYear()),
    updatedAt: [...updatedDates].join(', ') || 'Unknown',
    fetchedAt: new Date().toISOString(),
    projections: positionResults.flatMap((result) => result.projections),
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');
  console.log(
    `Wrote ${snapshot.projections.length} FFToday projections (${snapshot.updatedAt})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
