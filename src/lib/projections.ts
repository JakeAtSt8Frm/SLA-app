/**
 * Third-party full-season projection snapshots.
 *
 * Sleeper's own season projection is fetched live in the browser, but the
 * outside sources publish HTML pages that do not allow browser cross-origin
 * requests. They are normalized into static JSON snapshots at build time
 * (`npm run refresh:projections`) and read back from `public/data`.
 *
 * Every source lands in the same shape — raw stat keys matching this league's
 * `scoring_settings` — so the ensemble can score each one independently in the
 * league's own format rather than trusting anyone's fantasy point total.
 */

import type { Player, PositionGroup, StatLine } from './types';
import { groupForPlayer } from './scoring';

/** Sources that ship as a build-time snapshot. Sleeper is fetched live. */
export type ExternalSourceName = 'FFToday' | 'FantasySharks';

/** Every projection source that can contribute to the ensemble. */
export type ProjectionSourceName = 'Sleeper' | ExternalSourceName;

export interface ExternalSourceConfig {
  /** Public page a reader can check the numbers against. */
  url: string;
  /** File name under `public/data`. */
  file: string;
}

export const EXTERNAL_SOURCES: Record<ExternalSourceName, ExternalSourceConfig> = {
  FFToday: {
    url: 'https://www.fftoday.com/rankings/playerproj.php?PosID=10&LeagueID=193033',
    file: 'fftoday-projections.json',
  },
  FantasySharks: {
    url: 'https://www.fantasysharks.com/apps/bert/forecasts/projections.php',
    file: 'fantasysharks-projections.json',
  },
};

export const EXTERNAL_SOURCE_NAMES = Object.keys(EXTERNAL_SOURCES) as ExternalSourceName[];

export interface ExternalProjection {
  /** The source's own player id, kept so a row can be traced back upstream. */
  sourceId: string;
  name: string;
  team: string;
  group: PositionGroup;
  stats: StatLine;
}

export interface ProjectionSnapshot {
  source: ExternalSourceName;
  sourceUrl: string;
  season: string;
  /** The source's own "last updated" stamp, as published. */
  updatedAt: string;
  fetchedAt: string;
  projections: ExternalProjection[];
}

const POSITION_GROUPS = new Set<PositionGroup>([
  'QB',
  'RB',
  'WR',
  'TE',
  'K',
  'DL',
  'LB',
  'DB',
]);

/**
 * Team codes that differ from Sleeper's.
 *
 * FFToday uses `JAC`/`LA`; FantasySharks pads several to three letters.
 */
const TEAM_ALIASES: Record<string, string> = {
  JAC: 'JAX',
  LA: 'LAR',
  LAV: 'LV',
  LVR: 'LV',
  GBP: 'GB',
  KCC: 'KC',
  NEP: 'NE',
  NOS: 'NO',
  SFO: 'SF',
  TBB: 'TB',
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  WSH: 'WAS',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProjection(value: unknown): ExternalProjection | null {
  if (!isRecord(value)) return null;
  const { sourceId, name, team, group, stats } = value;
  if (
    typeof sourceId !== 'string' ||
    typeof name !== 'string' ||
    typeof team !== 'string' ||
    typeof group !== 'string' ||
    !POSITION_GROUPS.has(group as PositionGroup) ||
    !isRecord(stats)
  ) {
    return null;
  }

  const parsedStats: StatLine = {};
  for (const [key, raw] of Object.entries(stats)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) parsedStats[key] = raw;
  }
  if (Object.keys(parsedStats).length === 0) return null;

  return {
    sourceId,
    name,
    team: normalizeTeam(team),
    group: group as PositionGroup,
    stats: parsedStats,
  };
}

/** Validates a build-time snapshot before it reaches the value model. */
export function parseProjectionSnapshot(
  value: unknown,
  expectedSource?: ExternalSourceName,
): ProjectionSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.projections)) return null;
  if (
    typeof value.source !== 'string' ||
    !(value.source in EXTERNAL_SOURCES) ||
    (expectedSource !== undefined && value.source !== expectedSource) ||
    typeof value.sourceUrl !== 'string' ||
    typeof value.season !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.fetchedAt !== 'string'
  ) {
    return null;
  }

  const projections = value.projections
    .map(parseProjection)
    .filter((entry): entry is ExternalProjection => entry !== null);
  if (projections.length === 0) return null;

  return {
    source: value.source as ExternalSourceName,
    sourceUrl: value.sourceUrl,
    season: value.season,
    updatedAt: value.updatedAt,
    fetchedAt: value.fetchedAt,
    projections,
  };
}

/**
 * Reads one source's snapshot, or null when it is missing, malformed or stale.
 *
 * A snapshot for a different season is discarded rather than shown: last
 * year's forecast is worse than no forecast.
 */
export async function getProjectionSnapshot(
  source: ExternalSourceName,
  season: string,
  signal?: AbortSignal,
): Promise<ProjectionSnapshot | null> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}data/${EXTERNAL_SOURCES[source].file}`,
    { signal },
  );
  if (!response.ok) return null;
  const snapshot = parseProjectionSnapshot(await response.json(), source);
  return snapshot?.season === season ? snapshot : null;
}

const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(SUFFIXES, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Last name only, for the team+position fallback match. */
function normalizeSurname(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(SUFFIXES, '')
    .split(/[^a-z0-9'-]+/)
    .filter(Boolean);
  const last = words[words.length - 1] ?? '';
  return last.replace(/[^a-z0-9]/g, '');
}

export function normalizeTeam(team: string | null | undefined): string {
  const normalized = String(team ?? '').trim().toUpperCase();
  return TEAM_ALIASES[normalized] ?? normalized;
}

function playerName(player: Player): string {
  return player.full_name ?? `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim();
}

function playerSurname(player: Player): string {
  return normalizeSurname(player.last_name ?? playerName(player));
}

interface Candidate {
  pid: string;
  team: string;
  group: PositionGroup;
}

/**
 * Matches a source's rows to Sleeper ids without fuzzy name guesses.
 *
 * A unique normalized full-name match is safe even after a trade or an edge
 * player's DL/LB eligibility disagreement, and duplicate names are resolved by
 * position and team. What full names miss is the roughly 2% of rows where the
 * two sites use different forms of the same first name — "Ken" vs "Kenneth"
 * Gainwell, "Pat" vs "Patrick" Surtain. Those fall through to a surname match
 * that additionally requires the team *and* the position group to agree and to
 * be unique on all three, which is a tighter constraint than the full-name pass
 * it backs up.
 */
export function matchProjections(
  snapshot: ProjectionSnapshot,
  playersById: Map<string, Player>,
): Record<string, StatLine> {
  const byName = new Map<string, Candidate[]>();
  const bySurname = new Map<string, Candidate[]>();

  for (const [pid, player] of playersById) {
    const group = groupForPlayer(player);
    const name = normalizeName(playerName(player));
    if (!group || !name) continue;
    const candidate: Candidate = { pid, team: normalizeTeam(player.team), group };

    const named = byName.get(name);
    if (named) named.push(candidate);
    else byName.set(name, [candidate]);

    const surname = playerSurname(player);
    if (!surname) continue;
    const key = `${surname}|${group}|${candidate.team}`;
    const surnamed = bySurname.get(key);
    if (surnamed) surnamed.push(candidate);
    else bySurname.set(key, [candidate]);
  }

  const matched: Record<string, StatLine> = {};
  const unmatched: ExternalProjection[] = [];

  for (const projection of snapshot.projections) {
    const bucket = byName.get(normalizeName(projection.name));
    if (!bucket?.length) {
      unmatched.push(projection);
      continue;
    }

    const sameGroup = bucket.filter((candidate) => candidate.group === projection.group);
    const team = normalizeTeam(projection.team);
    const target = sameGroup.length === 1
      ? sameGroup[0]
      : sameGroup.find((candidate) => candidate.team === team) ??
        (bucket.length === 1
          ? bucket[0]
          : bucket.find((candidate) => candidate.team === team));
    if (!target) {
      unmatched.push(projection);
      continue;
    }
    if (matched[target.pid] === undefined) matched[target.pid] = projection.stats;
  }

  for (const projection of unmatched) {
    const key = `${normalizeSurname(projection.name)}|${projection.group}|${normalizeTeam(projection.team)}`;
    const bucket = bySurname.get(key);
    if (bucket?.length !== 1) continue;
    const { pid } = bucket[0];
    if (matched[pid] === undefined) matched[pid] = projection.stats;
  }

  return matched;
}
