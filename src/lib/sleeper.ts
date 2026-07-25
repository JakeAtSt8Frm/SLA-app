/**
 * Sleeper API client.
 *
 * Two hosts are in play and they are not interchangeable:
 *   api.sleeper.app  — the documented v1 endpoints (league, rosters, users,
 *                      matchups, transactions, players)
 *   api.sleeper.com  — undocumented endpoints (schedule, per-team stat splits)
 * The stats/projections endpoints answer on both; we try .app first and fall
 * back, because one of them intermittently rate-limits during Sunday games.
 *
 * Everything is public and CORS-enabled, which is what lets this app ship as a
 * static site with no backend.
 */

import type {
  League,
  Matchup,
  NflState,
  Player,
  ResearchEntry,
  Roster,
  SleeperUser,
  StatLine,
} from './types';

const V1 = 'https://api.sleeper.app/v1';
const APP = 'https://api.sleeper.app';
const COM = 'https://api.sleeper.com';

export class SleeperError extends Error {
  readonly status?: number;
  readonly url?: string;

  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'SleeperError';
    this.status = status;
    this.url = url;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new SleeperError(`Request failed (${res.status})`, res.status, url);
  }
  return (await res.json()) as T;
}

/** Tries each URL in order, returning the first success. */
async function getFirst<T>(urls: string[], signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await getJson<T>(url, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new SleeperError('All endpoints failed');
}

export const getNflState = (signal?: AbortSignal) =>
  getJson<NflState>(`${V1}/state/nfl`, signal);

export const getLeague = (leagueId: string, signal?: AbortSignal) =>
  getJson<League>(`${V1}/league/${leagueId}`, signal);

export const getUsers = (leagueId: string, signal?: AbortSignal) =>
  getJson<SleeperUser[]>(`${V1}/league/${leagueId}/users`, signal);

export const getRosters = (leagueId: string, signal?: AbortSignal) =>
  getJson<Roster[]>(`${V1}/league/${leagueId}/rosters`, signal);

export const getMatchups = (leagueId: string, week: number, signal?: AbortSignal) =>
  getJson<Matchup[]>(`${V1}/league/${leagueId}/matchups/${week}`, signal);

export const getWinnersBracket = (leagueId: string, signal?: AbortSignal) =>
  getJson<unknown[]>(`${V1}/league/${leagueId}/winners_bracket`, signal);

export const getLosersBracket = (leagueId: string, signal?: AbortSignal) =>
  getJson<unknown[]>(`${V1}/league/${leagueId}/losers_bracket`, signal);

export const getTransactions = (leagueId: string, week: number, signal?: AbortSignal) =>
  getJson<unknown[]>(`${V1}/league/${leagueId}/transactions/${week}`, signal);

/** The full NFL player dictionary. ~2.5MB gzipped — cache aggressively. */
export const getAllPlayers = (signal?: AbortSignal) =>
  getJson<Record<string, Player>>(`${V1}/players/nfl`, signal);

export const getSchedule = (season: string, signal?: AbortSignal) =>
  getJson<Array<{ week: number; home: string; away: string; status: string; date: string }>>(
    `${COM}/schedule/nfl/regular/${season}`,
    signal,
  );

/** Trending adds — used to surface waiver activity on the players page. */
export const getTrendingAdds = (signal?: AbortSignal) =>
  getJson<Array<{ player_id: string; count: number }>>(
    `${V1}/players/nfl/trending/add?lookback_hours=24&limit=25`,
    signal,
  );

/**
 * Ownership / start-rate research for a week.
 *
 * Feeds current ownership/start-rate context into the in-season form model.
 * Returns an empty map rather than throwing because this endpoint is the least
 * reliable of the set.
 */
export async function getResearch(
  season: string,
  week: number,
  seasonType: string,
  signal?: AbortSignal,
): Promise<Record<string, ResearchEntry>> {
  const segment = seasonType === 'post' || seasonType === 'postseason' ? 'post' : 'regular';
  try {
    return await getJson<Record<string, ResearchEntry>>(
      `${APP}/players/nfl/research/${segment}/${season}/${week}`,
      signal,
    );
  } catch {
    return {};
  }
}

/**
 * A week's stats or projections, normalised into lookup maps.
 *
 * The raw endpoint returns a flat array of ~2100 entries, each wrapping a full
 * player object we already have. We keep only the stat line and the opponent,
 * which cuts the in-memory footprint by roughly an order of magnitude and makes
 * the payload cheap to persist.
 */
export interface WeekStatsResult {
  /** pid -> stat line */
  stats: Record<string, StatLine>;
  /** pid -> opponent team abbreviation, for the matchup model */
  opponents: Record<string, string>;
  /** pid -> the player's own team that week */
  teams: Record<string, string>;
}

interface RawStatEntry {
  player_id?: string;
  stats?: StatLine;
  opponent?: string | null;
  team?: string | null;
}

function normalizeWeekPayload(raw: unknown): WeekStatsResult {
  const stats: Record<string, StatLine> = {};
  const opponents: Record<string, string> = {};
  const teams: Record<string, string> = {};

  if (Array.isArray(raw)) {
    for (const entry of raw as RawStatEntry[]) {
      const pid = entry?.player_id ? String(entry.player_id) : '';
      if (!pid || !entry.stats) continue;
      stats[pid] = entry.stats;
      if (entry.opponent) opponents[pid] = String(entry.opponent).toUpperCase();
      if (entry.team) teams[pid] = String(entry.team).toUpperCase();
    }
    return { stats, opponents, teams };
  }

  // Older shape: a plain object keyed by player id, with no opponent field.
  if (raw && typeof raw === 'object') {
    for (const [pid, line] of Object.entries(raw as Record<string, StatLine>)) {
      if (line && typeof line === 'object') stats[String(pid)] = line;
    }
  }

  return { stats, opponents, teams };
}

export async function getWeekStats(
  season: string,
  week: number,
  seasonType: string,
  signal?: AbortSignal,
): Promise<WeekStatsResult> {
  const query = `?season_type=${seasonType}`;
  const raw = await getFirst<unknown>(
    [
      `${APP}/stats/nfl/${season}/${week}${query}`,
      `${COM}/stats/nfl/${season}/${week}${query}`,
    ],
    signal,
  );
  return normalizeWeekPayload(raw);
}

export async function getWeekProjections(
  season: string,
  week: number,
  seasonType: string,
  signal?: AbortSignal,
): Promise<WeekStatsResult> {
  const query = `?season_type=${seasonType}`;
  const raw = await getFirst<unknown>(
    [
      `${APP}/projections/nfl/${season}/${week}${query}`,
      `${COM}/projections/nfl/${season}/${week}${query}`,
    ],
    signal,
  );
  return normalizeWeekPayload(raw);
}

/* -------------------------------------------------------------------------- */
/* Asset URLs                                                                  */
/* -------------------------------------------------------------------------- */

export const playerHeadshot = (pid: string) =>
  `https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`;

export const teamLogo = (team: string | null | undefined) =>
  team ? `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png` : '';

export const userAvatar = (avatar: string | null | undefined) =>
  avatar ? `https://sleepercdn.com/avatars/thumbs/${avatar}` : '';
