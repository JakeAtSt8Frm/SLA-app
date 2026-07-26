import type { Player, PositionGroup, StatLine } from './types';
import { groupForPlayer } from './scoring';

export const FFTODAY_SOURCE_URL =
  'https://www.fftoday.com/rankings/playerproj.php?PosID=10&LeagueID=193033';

export interface FftodayProjection {
  fftodayId: string;
  name: string;
  team: string;
  group: PositionGroup;
  stats: StatLine;
}

export interface FftodaySnapshot {
  source: 'FFToday';
  sourceUrl: string;
  season: string;
  updatedAt: string;
  fetchedAt: string;
  projections: FftodayProjection[];
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

const TEAM_ALIASES: Record<string, string> = {
  JAC: 'JAX',
  LA: 'LAR',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProjection(value: unknown): FftodayProjection | null {
  if (!isRecord(value)) return null;
  const { fftodayId, name, team, group, stats } = value;
  if (
    typeof fftodayId !== 'string' ||
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
    fftodayId,
    name,
    team: normalizeTeam(team),
    group: group as PositionGroup,
    stats: parsedStats,
  };
}

/** Validates the build-time snapshot before it reaches the value model. */
export function parseFftodaySnapshot(value: unknown): FftodaySnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.projections)) return null;
  if (
    value.source !== 'FFToday' ||
    typeof value.sourceUrl !== 'string' ||
    typeof value.season !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.fetchedAt !== 'string'
  ) {
    return null;
  }

  const projections = value.projections
    .map(parseProjection)
    .filter((entry): entry is FftodayProjection => entry !== null);
  if (projections.length === 0) return null;

  return {
    source: 'FFToday',
    sourceUrl: value.sourceUrl,
    season: value.season,
    updatedAt: value.updatedAt,
    fetchedAt: value.fetchedAt,
    projections,
  };
}

export async function getFftodaySnapshot(
  season: string,
  signal?: AbortSignal,
): Promise<FftodaySnapshot | null> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}data/fftoday-projections.json`,
    { signal },
  );
  if (!response.ok) return null;
  const snapshot = parseFftodaySnapshot(await response.json());
  return snapshot?.season === season ? snapshot : null;
}

function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeTeam(team: string | null | undefined): string {
  const normalized = String(team ?? '').trim().toUpperCase();
  return TEAM_ALIASES[normalized] ?? normalized;
}

function playerName(player: Player): string {
  return player.full_name ?? `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim();
}

/**
 * Matches FFToday rows to Sleeper ids without fuzzy name guesses.
 *
 * A unique normalized name match is safe even after a trade or an edge-player
 * DL/LB eligibility disagreement. When duplicate names exist, position and
 * team are required to disambiguate them.
 */
export function matchFftodayProjections(
  snapshot: FftodaySnapshot,
  playersById: Map<string, Player>,
): Record<string, StatLine> {
  const candidates = new Map<
    string,
    Array<{ pid: string; team: string; group: PositionGroup }>
  >();

  for (const [pid, player] of playersById) {
    const group = groupForPlayer(player);
    const name = normalizeName(playerName(player));
    if (!group || !name) continue;
    const entry = { pid, team: normalizeTeam(player.team), group };
    const bucket = candidates.get(name);
    if (bucket) bucket.push(entry);
    else candidates.set(name, [entry]);
  }

  const matched: Record<string, StatLine> = {};
  for (const projection of snapshot.projections) {
    const bucket = candidates.get(normalizeName(projection.name));
    if (!bucket?.length) continue;

    const sameGroup = bucket.filter((candidate) => candidate.group === projection.group);
    const team = normalizeTeam(projection.team);
    const target = sameGroup.length === 1
      ? sameGroup[0]
      : sameGroup.find((candidate) => candidate.team === team) ??
        (bucket.length === 1
          ? bucket[0]
          : bucket.find((candidate) => candidate.team === team));
    if (target && matched[target.pid] === undefined) {
      matched[target.pid] = projection.stats;
    }
  }

  return matched;
}
