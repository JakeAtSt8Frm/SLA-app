/**
 * League data loading and derivation.
 *
 * Loads everything a season needs, then derives the three metric indices once.
 * The heavy work (value index over ~2000 players x 17 weeks) runs a single time
 * per season and every page reads the result, which is what keeps the app
 * responsive on a phone.
 */

import { cached, TTL } from './cache';
import {
  getAllPlayers,
  getLeague,
  getMatchups,
  getNflState,
  getResearch,
  getRosters,
  getUsers,
  getWeekProjections,
  getWeekStats,
  getWinnersBracket,
} from '../lib/sleeper';
import {
  compileScoring,
  createScorer,
  groupForPlayer,
  hasPlayed,
  type ScoringModel,
} from '../lib/scoring';
import { buildValueIndex, type ValueIndex } from '../lib/value';
import { buildDynastyIndex, type DynastyIndex, type SeasonPpg } from '../lib/dynasty';
import { getMarketValues, marketQueryFromLeague } from '../lib/market';
import { buildMatchupIndex, type MatchupIndex } from '../lib/matchup';
import { starterSlots } from '../lib/optimal';
import type {
  League,
  Matchup,
  NflState,
  Player,
  Roster,
  SleeperUser,
  StatLine,
} from '../lib/types';

/** Season -> league id. Add a row here each year. */
export const SEASON_LEAGUES: Record<string, string> = {
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
  '2026': '1312656463549726720',
};

export const SEASONS = Object.keys(SEASON_LEAGUES).sort().reverse();

export interface TeamInfo {
  rosterId: number;
  name: string;
  ownerName: string;
  avatar: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  roster: Roster;
  /** Final placement from the playoff bracket: 1 = champion. */
  placement: number | null;
}

/**
 * Final standings from the winners bracket.
 *
 * Sleeper marks placement games with a `p` field — `p: 1` is the championship,
 * `p: 3` the third-place game — so the champion is the winner of the `p: 1`
 * match rather than whoever finished top of the regular season.
 */
export interface BracketMatch {
  p?: number;
  w?: number | null;
  l?: number | null;
}

export function placementsFromBracket(bracket: BracketMatch[]): Map<number, number> {
  const placements = new Map<number, number>();

  for (const match of bracket ?? []) {
    if (typeof match?.p !== 'number') continue;
    // The winner takes the placement, the loser the one below it.
    if (typeof match.w === 'number') placements.set(match.w, match.p);
    if (typeof match.l === 'number' && !placements.has(match.l)) {
      placements.set(match.l, match.p + 1);
    }
  }

  return placements;
}

export interface WeekData {
  week: number;
  stats: Record<string, StatLine>;
  projections: Record<string, StatLine>;
  opponents: Record<string, string>;
  teams: Record<string, string>;
  matchups: Matchup[];
}

export interface LeagueData {
  season: string;
  /** Season the rosters came from — differs from `season` when overridden. */
  rosterSeason: string;
  league: League;
  /** The league the rosters were read from, when it isn't `league`. */
  rosterLeague: League | null;
  /**
   * True when rosters come from a different season than the scoring.
   *
   * Consumers must not read lineups out of the weekly matchup records in this
   * mode: those belong to the scoring season and would silently override the
   * roster the user asked to see.
   */
  rostersOverridden: boolean;
  /** Roster id of the champion, when the season has a completed bracket. */
  championRosterId: number | null;
  nflState: NflState;
  scoringModel: ScoringModel;
  score: (stats: StatLine | undefined | null) => number;
  playersById: Map<string, Player>;
  teams: TeamInfo[];
  teamsById: Map<number, TeamInfo>;
  weeks: Map<number, WeekData>;
  /** Last week with any completed games — the app's default view. */
  currentWeek: number;
  /** Highest week we loaded data for. */
  maxWeek: number;
  starterSlots: string[];
  valueIndex: ValueIndex;
  dynastyIndex: DynastyIndex;
  /**
   * The headline player value shown across the app: market-independent dynasty
   * intrinsic value. Current form and market/consensus values remain separate.
   * Players without a dynasty projection fall back to current form.
   */
  headlineScores: Map<string, number>;
  matchupIndex: MatchupIndex;
}

export interface LoadProgress {
  phase: string;
  loaded: number;
  total: number;
}

/**
 * Resolves how many weeks of a season actually have data.
 *
 * A completed season has 17-18; an in-progress one has however many have been
 * played. Loading beyond that wastes bandwidth and produces empty weeks that
 * skew the per-game averages in the value model.
 */
function resolveMaxWeek(league: League, state: NflState, season: string): number {
  const REGULAR_SEASON_WEEKS = 18;

  // A finished season: load everything through the playoffs the league used.
  if (league.status === 'complete') {
    const playoffStart = Number(league.settings?.playoff_week_start ?? 15);
    return Math.min(REGULAR_SEASON_WEEKS, Math.max(playoffStart + 2, 17));
  }

  // The season currently in progress.
  if (state.season === season) {
    const wk = Number(state.week ?? state.leg ?? 1);
    return Math.max(1, Math.min(REGULAR_SEASON_WEEKS, wk));
  }

  // A past season that isn't flagged complete — assume a full regular season.
  if (Number(season) < Number(state.season)) return REGULAR_SEASON_WEEKS;

  // A future / pre-draft season has nothing to load.
  return 0;
}

/** Small concurrency limiter — Sleeper rate-limits bursts of parallel requests. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Blended per-player PPG for a single past season, scored in the *current*
 * league's format so the multi-year dynasty blend compares like with like.
 *
 * Stats are NFL-wide and league-independent, so this needs only the year — no
 * league id — which is what lets the dynasty model reach back past the seasons
 * that happen to be configured in `SEASON_LEAGUES`. Every fetch is best-effort;
 * a missing week simply doesn't contribute.
 */
async function loadSeasonPpg(
  season: string,
  scoringModel: ScoringModel,
  playersById: Map<string, Player>,
  signal?: AbortSignal,
): Promise<SeasonPpg> {
  const score = createScorer(scoringModel);
  const totals = new Map<string, { total: number; games: number }>();
  const weekNumbers = Array.from({ length: 18 }, (_, i) => i + 1);

  await mapLimit(weekNumbers, 4, async (week) => {
    const res = await cached(`stats:${season}:${week}`, TTL.FINAL_WEEK, () =>
      getWeekStats(season, week, 'regular', signal),
    ).catch(() => null);
    if (!res) return;

    for (const [pid, line] of Object.entries(res.stats)) {
      if (!playersById.has(pid) || !hasPlayed(line)) continue;
      const t = totals.get(pid) ?? { total: 0, games: 0 };
      t.total += score(line);
      t.games += 1;
      totals.set(pid, t);
    }
  });

  const out: SeasonPpg = new Map();
  for (const [pid, t] of totals) {
    if (t.games > 0) out.set(pid, { ppg: t.total / t.games, games: t.games });
  }
  return out;
}

/**
 * Loads a season.
 *
 * `rosterSeason` lets the rosters come from a different year than the scoring
 * and stats — e.g. "show me 2026's rosters scored against 2025's results", which
 * is how you evaluate a keeper or draft class against known production. When it
 * is omitted (the normal case) both come from the same league.
 */
export async function loadLeague(
  season: string,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
  rosterSeason?: string,
): Promise<LeagueData> {
  const leagueId = SEASON_LEAGUES[season];
  if (!leagueId) throw new Error(`No league configured for season ${season}`);

  const effectiveRosterSeason =
    rosterSeason && SEASON_LEAGUES[rosterSeason] ? rosterSeason : season;
  const rosterLeagueId = SEASON_LEAGUES[effectiveRosterSeason];
  const rostersAreOverridden = rosterLeagueId !== leagueId;

  const report = (phase: string, loaded: number, total: number) =>
    onProgress?.({ phase, loaded, total });

  report('Connecting to Sleeper', 0, 1);

  const [nflState, league] = await Promise.all([
    cached(`state`, TTL.STATE, () => getNflState(signal)),
    cached(`league:${leagueId}`, TTL.LEAGUE, () => getLeague(leagueId, signal)),
  ]);

  const scoringModel = compileScoring(league.scoring_settings);
  const score = createScorer(scoringModel);

  report('Loading rosters', 0, 1);

  const [users, rosters, playersRaw, bracket, rosterLeague] = await Promise.all([
    cached(`users:${rosterLeagueId}`, TTL.ROSTERS, () => getUsers(rosterLeagueId, signal)),
    cached(`rosters:${rosterLeagueId}`, TTL.ROSTERS, () => getRosters(rosterLeagueId, signal)),
    cached(`players`, TTL.PLAYERS, () => getAllPlayers(signal)),
    // The bracket only exists once the playoffs have been seeded.
    cached(`bracket:${leagueId}`, TTL.LEAGUE, () =>
      getWinnersBracket(leagueId, signal).catch(() => [] as unknown[]),
    ),
    rostersAreOverridden
      ? cached(`league:${rosterLeagueId}`, TTL.LEAGUE, () => getLeague(rosterLeagueId, signal))
      : Promise.resolve(null),
  ]);

  const placements = placementsFromBracket(bracket as BracketMatch[]);
  const championRosterId =
    [...placements.entries()].find(([, place]) => place === 1)?.[0] ?? null;

  const playersById = new Map<string, Player>(Object.entries(playersRaw));
  const usersById = new Map<string, SleeperUser>(users.map((u) => [u.user_id, u]));

  const teams: TeamInfo[] = rosters
    .map((roster) => {
      const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;
      const ownerName = user?.display_name ?? user?.username ?? `Team ${roster.roster_id}`;
      const teamName = roster.metadata?.team_name?.trim() || ownerName;
      const s = roster.settings ?? ({} as Roster['settings']);

      // Sleeper splits fantasy points into integer and decimal parts.
      const pf = (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100;
      const pa = (s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100;

      return {
        rosterId: roster.roster_id,
        name: teamName,
        ownerName,
        avatar: user?.avatar ?? null,
        wins: s.wins ?? 0,
        losses: s.losses ?? 0,
        ties: s.ties ?? 0,
        pointsFor: Math.round(pf * 100) / 100,
        pointsAgainst: Math.round(pa * 100) / 100,
        roster,
        // Placement belongs to the scoring season's bracket, so it is only
        // meaningful when the rosters come from that same season.
        placement: rostersAreOverridden
          ? null
          : (placements.get(roster.roster_id) ?? null),
      };
    })
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);

  const maxWeek = resolveMaxWeek(league, nflState, season);
  const weeks = new Map<number, WeekData>();

  if (maxWeek > 0) {
    const weekNumbers = Array.from({ length: maxWeek }, (_, i) => i + 1);
    let done = 0;

    // The live week must not be served from a long-lived cache entry.
    const liveWeek = nflState.season === season ? Number(nflState.week ?? 0) : 0;

    await mapLimit(weekNumbers, 4, async (week) => {
      const ttl = week === liveWeek ? TTL.LIVE_WEEK : TTL.FINAL_WEEK;
      const base = `${season}:${week}`;

      const [stats, projections, matchups] = await Promise.all([
        cached(`stats:${base}`, ttl, () => getWeekStats(season, week, 'regular', signal)),
        cached(`proj:${base}`, ttl, () => getWeekProjections(season, week, 'regular', signal)),
        cached(`matchups:${leagueId}:${week}`, ttl, () =>
          getMatchups(leagueId, week, signal).catch(() => [] as Matchup[]),
        ),
      ]);

      weeks.set(week, {
        week,
        stats: stats.stats,
        projections: projections.stats,
        opponents: stats.opponents,
        teams: stats.teams,
        matchups,
      });

      done++;
      report('Loading weekly stats', done, weekNumbers.length);
    });
  }

  // The current week is the last one where anybody actually recorded a stat.
  let currentWeek = 1;
  for (const [week, data] of weeks) {
    if (Object.keys(data.stats).length > 0) currentWeek = Math.max(currentWeek, week);
  }

  report('Computing metrics', 0, 2);

  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();
  for (const [week, data] of weeks) {
    weekStats.set(week, data.stats);
    weekProjections.set(week, data.projections);
    weekOpponents.set(week, data.opponents);
    weekTeams.set(week, data.teams);
  }

  // Ownership data only exists for the live week; it's a tiny input, so a
  // failure here shouldn't hold up the load.
  const research =
    nflState.season === season && currentWeek > 0
      ? await getResearch(season, currentWeek, 'regular', signal).catch(() => ({}))
      : {};

  const valueIndex = buildValueIndex({
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekOpponents,
    weekTeams,
    forecastProjections:
      nflState.season === season
        ? weeks.get(Math.min(maxWeek, currentWeek + 1))?.projections
        : undefined,
    research,
    throughWeek: currentWeek,
  });

  report('Computing metrics', 1, 3);

  const matchupIndex = buildMatchupIndex({
    scoringModel,
    playersById,
    weekStats,
    weekOpponents,
    weekTeams,
    throughWeek: currentWeek,
  });

  report('Loading dynasty inputs', 2, 3);

  // Dynasty inputs are all best-effort third-party / historical data: the two
  // prior seasons' production (for the 80/20 multi-year blend) and the current
  // trade market. A failure in either degrades the dynasty score gracefully
  // rather than blocking the app, so the core in-season views never wait on them.
  const priorYears = [String(Number(season) - 1), String(Number(season) - 2)];
  const marketQuery = marketQueryFromLeague(
    league.roster_positions,
    league.total_rosters,
    league.scoring_settings?.rec,
  );
  const [priorSeasons, market] = await Promise.all([
    Promise.all(
      priorYears.map((year) =>
        loadSeasonPpg(year, scoringModel, playersById, signal).catch(
          () => new Map() as SeasonPpg,
        ),
      ),
    ),
    getMarketValues(marketQuery, signal).catch(() => new Map()),
  ]);

  const dynastyIndex = buildDynastyIndex({
    valueIndex,
    playersById,
    priorSeasons,
    market,
    rosterPositions: league.roster_positions ?? [],
    numTeams: league.total_rosters ?? rosters.length,
    rosteredPlayerIds: new Set(
      teams.flatMap((team) => [
        ...(team.roster.players ?? []),
        ...(team.roster.taxi ?? []),
        ...(team.roster.reserve ?? []),
      ]),
    ),
    throughWeek: currentWeek,
  });

  // Dynasty intrinsic is the headline. The in-season model predicts a different
  // target (current/next-week form) and is displayed independently rather than
  // receiving an arbitrary 50% of long-term value.
  const headlineScores = new Map<string, number>();
  const scoredPids = new Set<string>([
    ...valueIndex.byPlayer.keys(),
    ...dynastyIndex.byPlayer.keys(),
  ]);
  for (const pid of scoredPids) {
    const d = dynastyIndex.byPlayer.get(pid)?.score ?? null;
    const v = valueIndex.byPlayer.get(pid)?.score ?? null;
    if (d !== null) headlineScores.set(pid, d);
    else if (v !== null) headlineScores.set(pid, v);
  }

  report('Ready', 3, 3);

  return {
    season,
    rosterSeason: effectiveRosterSeason,
    league,
    rosterLeague,
    rostersOverridden: rostersAreOverridden,
    championRosterId: rostersAreOverridden ? null : championRosterId,
    nflState,
    scoringModel,
    score,
    playersById,
    teams,
    teamsById: new Map(teams.map((t) => [t.rosterId, t])),
    weeks,
    currentWeek,
    maxWeek,
    starterSlots: starterSlots(league.roster_positions),
    valueIndex,
    dynastyIndex,
    headlineScores,
    matchupIndex,
  };
}

/* -------------------------------------------------------------------------- */
/* Derivation helpers used by the pages                                        */
/* -------------------------------------------------------------------------- */

/** Display name for a player, falling back through Sleeper's field variants. */
export function playerName(player: Player | undefined, pid: string): string {
  if (!player) return `Player ${pid}`;
  if (player.full_name) return player.full_name;
  const joined = [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
  return joined || `Player ${pid}`;
}

/** Statuses that mean a player cannot play this week. */
const OUT_STATUSES = new Set([
  'OUT',
  'IR',
  'PUP',
  'NFI',
  'SUSP',
  'SUSPENDED',
  'COVID',
  'INACTIVE',
  'DNR',
  'NA',
]);

export function isOut(player: Player | undefined): boolean {
  if (!player) return false;
  const status = String(player.injury_status ?? player.status ?? '').trim().toUpperCase();
  return OUT_STATUSES.has(status);
}

export { groupForPlayer };
