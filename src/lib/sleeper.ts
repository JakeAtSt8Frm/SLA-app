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

/**
 * Status codes worth trying again.
 *
 * 429 is the one that actually bites: a season load fires ~40 requests, and
 * Sleeper throttles bursts during Sunday games — exactly when someone opens the
 * app. The 5xx codes cover a gateway blip. Everything else (404 on a bracket that
 * doesn't exist yet, 400 on a malformed week) is a permanent answer, and retrying
 * it just delays the failure the caller already handles.
 */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Honours `Retry-After` when the server sends one, in either of its two forms. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;

    try {
      res = await fetch(url, { signal });
    } catch (err) {
      // An abort is the caller changing their mind, not a failure to retry.
      if (signal?.aborted) throw err;
      lastError = err;
      await backoff(attempt, null, signal);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    lastError = new SleeperError(`Request failed (${res.status})`, res.status, url);
    if (!RETRYABLE.has(res.status)) throw lastError;

    await backoff(attempt, retryAfterMs(res.headers.get('Retry-After')), signal);
  }

  throw lastError instanceof Error
    ? lastError
    : new SleeperError('Request failed', undefined, url);
}

/**
 * Waits before the next attempt, unless that was the last one.
 *
 * Exponential with jitter: a season load starts ~40 requests at the same instant,
 * so a fixed delay would retry them all in the same burst that got throttled.
 * A server's own `Retry-After` wins when it sends one and it is short enough to
 * be worth waiting out — past that the fallback host is the better move, and the
 * caller has one.
 */
async function backoff(attempt: number, advised: number | null, signal?: AbortSignal) {
  if (attempt >= MAX_ATTEMPTS - 1) return;
  const ADVICE_CAP_MS = 5000;
  if (advised !== null && advised <= ADVICE_CAP_MS) {
    await sleep(advised, signal);
    return;
  }
  const wait = BASE_BACKOFF_MS * 2 ** attempt;
  await sleep(wait + Math.random() * wait, signal);
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
 * Feeds the (deliberately tiny) market term in the Value Score. Returns an
 * empty map rather than throwing, since this endpoint is the least reliable of
 * the set and the model treats missing market data as neutral.
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

/**
 * Sleeper's season-long projection feed.
 *
 * This endpoint is not part of Sleeper's documented v1 API, so callers must
 * treat it as best-effort. Its payload matches the weekly projection shape but
 * carries full-season stat totals and no week.
 */
export async function getSeasonProjections(
  season: string,
  signal?: AbortSignal,
): Promise<WeekStatsResult> {
  const query = '?season_type=regular';
  const raw = await getFirst<unknown>(
    [
      `${APP}/projections/nfl/${season}${query}`,
      `${COM}/projections/nfl/${season}${query}`,
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
