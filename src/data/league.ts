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
  getSeasonProjections,
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
  opportunities,
  type ScoringModel,
} from '../lib/scoring';
import { buildValueIndex, type ValueIndex } from '../lib/value';
import {
  buildDynastyIndex,
  startingDepthByGroup,
  type DynastyIndex,
  type ProjectedSeason,
  type SeasonPpg,
  type SeasonProjectionMap,
} from '../lib/dynasty';
import {
  EXTERNAL_SOURCE_NAMES,
  getProjectionSnapshot,
  matchProjections,
  type ProjectionSourceName,
} from '../lib/projections';
import { getMarketValues, marketQueryFromLeague } from '../lib/market';
import {
  buildMatchupIndex,
  buildPregameMatchupIndexes,
  type MatchupIndex,
} from '../lib/matchup';
import { fitResidualModel, type ResidualModel } from '../lib/forecast';
import { starterSlots } from '../lib/optimal';
import { POSITION_GROUPS } from '../lib/types';
import type {
  League,
  Matchup,
  NflState,
  Player,
  PositionGroup,
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
   * The single headline Value Score shown across the app: the average of the
   * in-season Value Score and the dynasty score, both percentiled within
   * position so the two are on the same footing. Falls back to whichever exists
   * when a player carries only one.
   */
  combinedScores: Map<string, number>;
  /** Current defence ratings, built through the latest completed week. */
  matchupIndex: MatchupIndex;
  /** Pregame ratings for historical weeks, containing earlier results only. */
  pregameMatchupIndexes: Map<number, MatchupIndex>;
  /**
   * Fitted projection-error distributions, per position group. Turns any
   * projection into a distribution with a real floor and ceiling.
   */
  residualModel: ResidualModel;
  /** Regular-season pairings for weeks that haven't been played yet. */
  futureMatchups: Map<number, Matchup[]>;
  playoff: PlayoffFormat;
}

export interface PlayoffFormat {
  /** Teams that reach the playoff field. */
  teams: number;
  /** First playoff week; the regular season is everything before it. */
  weekStart: number;
  /** Weeks a playoff round spans. */
  weeksPerRound: number;
  /** Last regular-season week. */
  regularSeasonWeeks: number;
}

/**
 * Reads the league's own playoff configuration.
 *
 * Sleeper's `playoff_round_type` is an enum, not a count: 2 means every round
 * spans two weeks, which is what this league uses (four playoff weeks, two
 * rounds). Anything else is treated as a single week per round.
 */
export function playoffFormat(league: League): PlayoffFormat {
  const weekStart = Number(league.settings?.playoff_week_start ?? 15);
  return {
    teams: Math.max(2, Number(league.settings?.playoff_teams ?? 4)),
    weekStart,
    weeksPerRound: Number(league.settings?.playoff_round_type ?? 0) === 2 ? 2 : 1,
    regularSeasonWeeks: Math.max(1, weekStart - 1),
  };
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
 * Scores a source's full-season forecast with the league's custom rules.
 *
 * Sleeper currently reports `gp: 18` for a full NFL schedule including the bye
 * week, so the per-game rate is capped at the 17 games a player can play.
 */
function summarizeSeasonProjections(
  statsByPlayer: Record<string, StatLine>,
  scoringModel: ScoringModel,
  playersById: Map<string, Player>,
  sourceName: ProjectionSourceName,
  updatedAt?: string,
): SeasonProjectionMap {
  const NFL_GAMES = 17;
  const score = createScorer(scoringModel);
  const projections: SeasonProjectionMap = new Map();

  for (const [pid, stats] of Object.entries(statsByPlayer)) {
    const player = playersById.get(pid);
    const group = groupForPlayer(player);
    if (!group) continue;

    // Sleeper's TE-premium key mirrors receptions. FFToday publishes receiving
    // stats without a source-specific bonus field, so derive it from the
    // player's Sleeper eligibility before applying league scoring.
    const scoringStats =
      group === 'TE' && stats.bonus_rec_te === undefined
        ? { ...stats, bonus_rec_te: stats.rec ?? 0 }
        : stats;
    const total = score(scoringStats);
    if (total <= 0) continue;

    const rawGames = Number(stats.gp ?? NFL_GAMES);
    const games = Math.max(
      1,
      Math.min(NFL_GAMES, Number.isFinite(rawGames) ? rawGames : NFL_GAMES),
    );
    // Zero opportunity in a *forecast* means the source did not publish the
    // volume columns, not that the player is expected to see none — Sleeper's
    // season projection carries no field-goal or extra-point attempts at all.
    // Abstaining keeps that silence out of the ensemble instead of voting zero.
    const usage = opportunities(group, stats);
    projections.set(pid, {
      total,
      ppg: total / games,
      games,
      usagePerGame: usage === null || usage <= 0 ? null : usage / games,
      sources: [
        {
          name: sourceName,
          total,
          ppg: total / games,
          ...(updatedAt ? { updatedAt } : {}),
        },
      ],
    });
  }

  return projections;
}

/** A source needs this many players in a group before it can be rescaled. */
const CALIBRATION_MIN_SAMPLE = 8;
/** Sanity rails: a factor outside these is a parsing bug, not a house view. */
const CALIBRATION_LIMITS = { min: 0.5, max: 2 } as const;

function median(sortedDesc: number[]): number {
  const mid = Math.floor(sortedDesc.length / 2);
  return sortedDesc.length % 2
    ? sortedDesc[mid]
    : (sortedDesc[mid - 1] + sortedDesc[mid]) / 2;
}

/** Median of a source's top `anchor` players in a group, or null if too thin. */
function anchorLevel(values: number[], anchor: number): number | null {
  if (values.length < Math.max(CALIBRATION_MIN_SAMPLE, anchor)) return null;
  const top = [...values].sort((a, b) => b - a).slice(0, anchor);
  const level = median(top);
  return level > 0 ? level : null;
}

/**
 * Puts every source on a common per-position scale before they are averaged.
 *
 * The sources do not measure the same things. Sleeper's season projection omits
 * passes defensed entirely — 3 points a piece here — which leaves its defensive
 * backs about a fifth light against the other two. Its kickers carry no attempt
 * columns at all. And on usage, FantasySharks publishes targets where FFToday
 * and Sleeper publish only receptions, so a receiver's "opportunity" differs by
 * 60% between sources purely by definition.
 *
 * Averaged raw, that turns into a bias that depends on *which* sources happen to
 * cover a player: a deep defensive back only Sleeper lists would sit a fifth
 * below an identical one all three list, purely as an artefact of coverage.
 * Since everything downstream is a percentile within the position group, only
 * each source's *ordering* carries information — so each source is rescaled by a
 * single positive factor per group, which preserves its ordering exactly while
 * removing the level disagreement.
 *
 * The anchor is the median of a source's top `anchor` players in the group,
 * which is robust to both a runaway projection at the top and the long tail of
 * near-zero rows at the bottom. Per-source totals shown in the player sheet stay
 * as published; only the blend is rescaled.
 */
export function calibrateSeasonProjections(
  sources: SeasonProjectionMap[],
  groupOf: (pid: string) => PositionGroup | null,
  anchorByGroup: Map<PositionGroup, number>,
): SeasonProjectionMap[] {
  type Levels = Map<PositionGroup, { points: number | null; usage: number | null }>;

  const levelsBySource: Levels[] = sources.map((source) => {
    const points = new Map<PositionGroup, number[]>();
    const usage = new Map<PositionGroup, number[]>();
    const collect = (
      into: Map<PositionGroup, number[]>,
      group: PositionGroup,
      value: number,
    ) => {
      const bucket = into.get(group);
      if (bucket) bucket.push(value);
      else into.set(group, [value]);
    };

    for (const [pid, projection] of source) {
      const group = groupOf(pid);
      if (!group) continue;
      collect(points, group, projection.ppg);
      if (projection.usagePerGame !== null) {
        collect(usage, group, projection.usagePerGame);
      }
    }

    const levels: Levels = new Map();
    for (const group of POSITION_GROUPS) {
      const anchor = anchorByGroup.get(group) ?? 0;
      levels.set(group, {
        points: anchorLevel(points.get(group) ?? [], anchor),
        usage: anchorLevel(usage.get(group) ?? [], anchor),
      });
    }
    return levels;
  });

  // The shared target is the mean of the levels the sources do report, so no
  // single source defines the scale the others are pulled toward.
  const reference = new Map<PositionGroup, { points: number | null; usage: number | null }>();
  for (const group of POSITION_GROUPS) {
    const mean = (pick: (l: { points: number | null; usage: number | null }) => number | null) => {
      const values = levelsBySource
        .map((levels) => pick(levels.get(group)!))
        .filter((value): value is number => value !== null);
      return values.length > 1
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
    };
    reference.set(group, { points: mean((l) => l.points), usage: mean((l) => l.usage) });
  }

  const factor = (level: number | null, target: number | null): number => {
    if (level === null || target === null) return 1;
    return Math.min(CALIBRATION_LIMITS.max, Math.max(CALIBRATION_LIMITS.min, target / level));
  };

  return sources.map((source, index) => {
    const calibrated: SeasonProjectionMap = new Map();
    for (const [pid, projection] of source) {
      const group = groupOf(pid);
      const levels = group ? levelsBySource[index].get(group) : undefined;
      const target = group ? reference.get(group) : undefined;
      const points = factor(levels?.points ?? null, target?.points ?? null);
      const usage = factor(levels?.usage ?? null, target?.usage ?? null);
      calibrated.set(pid, {
        ...projection,
        total: projection.total * points,
        ppg: projection.ppg * points,
        usagePerGame:
          projection.usagePerGame === null ? null : projection.usagePerGame * usage,
      });
    }
    return calibrated;
  });
}

/**
 * Averages independent forecasts instead of summing several descriptions of the
 * same future season.
 *
 * Every source that covers a player gets an equal vote, and a player only one
 * source covers keeps that source's number in full: the sources disagree most
 * about exactly the deep IDP and kicker rows where only one of them bothers to
 * publish, so shrinking a lone forecast toward nothing would throw away the only
 * evidence there is.
 */
export function blendSeasonProjections(
  ...sources: SeasonProjectionMap[]
): SeasonProjectionMap {
  const blended: SeasonProjectionMap = new Map();
  const pids = new Set(sources.flatMap((source) => [...source.keys()]));

  for (const pid of pids) {
    const projections = sources
      .map((source) => source.get(pid))
      .filter((projection): projection is ProjectedSeason => projection !== undefined);
    if (projections.length === 0) continue;
    if (projections.length === 1) {
      blended.set(pid, projections[0]);
      continue;
    }

    const mean = (pick: (p: ProjectedSeason) => number) =>
      projections.reduce((sum, projection) => sum + pick(projection), 0) /
      projections.length;
    const usageValues = projections
      .map((projection) => projection.usagePerGame)
      .filter((value): value is number => value !== null);

    blended.set(pid, {
      total: mean((projection) => projection.total),
      ppg: mean((projection) => projection.ppg),
      games: Math.max(...projections.map((projection) => projection.games)),
      usagePerGame:
        usageValues.length > 0
          ? usageValues.reduce((sum, value) => sum + value, 0) / usageValues.length
          : null,
      sources: projections.flatMap((projection) => projection.sources),
    });
  }

  return blended;
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
  const pregameMatchupIndexes = buildPregameMatchupIndexes(
    {
      scoringModel,
      playersById,
      weekStats,
      weekOpponents,
      weekTeams,
    },
    maxWeek,
  );

  /*
   * Projection-error distributions, fit on every projected player-week loaded
   * above. This is what lets the app quote a floor and a ceiling instead of a
   * single number, and it costs one extra pass over data already in memory.
   */
  const residualModel = fitResidualModel({
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekTeams,
    throughWeek: currentWeek,
  });

  /*
   * Pairings for regular-season weeks still to be played. Results don't exist
   * yet, but Sleeper publishes the schedule, and without it a rest-of-season
   * simulation has nothing to simulate. Cheap (a few hundred bytes a week) and
   * best-effort: a failure just shortens the horizon.
   */
  const format = playoffFormat(league);
  const futureMatchups = new Map<number, Matchup[]>();
  if (maxWeek > 0 && maxWeek < format.regularSeasonWeeks) {
    const upcoming = Array.from(
      { length: format.regularSeasonWeeks - maxWeek },
      (_, i) => maxWeek + 1 + i,
    );
    await mapLimit(upcoming, 4, async (week) => {
      const pairings = await cached(`matchups:${leagueId}:${week}`, TTL.LIVE_WEEK, () =>
        getMatchups(leagueId, week, signal).catch(() => [] as Matchup[]),
      ).catch(() => [] as Matchup[]);
      if (pairings.length) futureMatchups.set(week, pairings);
    });
  }

  report('Loading dynasty inputs', 2, 3);

  // Dynasty inputs are all best-effort third-party / historical data: prior
  // production, the current season forecast and the trade market. A failure in
  // any one degrades the model gracefully rather than blocking the app.
  const priorYears = [String(Number(season) - 1), String(Number(season) - 2)];
  const marketQuery = marketQueryFromLeague(
    league.roster_positions,
    league.total_rosters,
    league.scoring_settings?.rec,
  );
  const isCurrentSeason = nflState.season === season;
  const [priorSeasons, market, sleeperProjectionPayload, externalSnapshots] =
    await Promise.all([
      Promise.all(
        priorYears.map((year) =>
          loadSeasonPpg(year, scoringModel, playersById, signal).catch(
            () => new Map() as SeasonPpg,
          ),
        ),
      ),
      getMarketValues(marketQuery, signal).catch(() => new Map()),
      isCurrentSeason
        ? cached(`proj-season:${season}`, TTL.SEASON_PROJECTIONS, () =>
            getSeasonProjections(season, signal),
          ).catch(() => null)
        : Promise.resolve(null),
      Promise.all(
        EXTERNAL_SOURCE_NAMES.map((source) =>
          isCurrentSeason
            ? getProjectionSnapshot(source, season, signal).catch(() => null)
            : Promise.resolve(null),
        ),
      ),
    ]);

  const sleeperProjections: SeasonProjectionMap = sleeperProjectionPayload
    ? summarizeSeasonProjections(
        sleeperProjectionPayload.stats,
        scoringModel,
        playersById,
        'Sleeper',
      )
    : new Map();
  const externalProjections = externalSnapshots.map((snapshot) =>
    snapshot
      ? summarizeSeasonProjections(
          matchProjections(snapshot, playersById),
          scoringModel,
          playersById,
          snapshot.source,
          snapshot.updatedAt,
        )
      : (new Map() as SeasonProjectionMap),
  );
  const rosterPositions = league.roster_positions ?? [];
  const numTeams = league.total_rosters ?? rosters.length;

  // Twice the startable depth is a wide enough band to include the
  // replacement-level players whose scale matters most, and still narrow enough
  // to exclude each source's long tail of near-zero rows.
  const anchorByGroup = new Map(
    [...startingDepthByGroup(rosterPositions, numTeams)].map(
      ([group, depth]) => [group, Math.max(24, Math.round(depth * 2))] as const,
    ),
  );
  const seasonProjections = blendSeasonProjections(
    ...calibrateSeasonProjections(
      [sleeperProjections, ...externalProjections],
      (pid) => groupForPlayer(playersById.get(pid)),
      anchorByGroup,
    ),
  );

  const dynastyIndex = buildDynastyIndex({
    valueIndex,
    playersById,
    priorSeasons,
    seasonProjections,
    market,
    rosterPositions,
    numTeams,
    throughWeek: currentWeek,
  });

  // The one headline number: the average of in-season form and dynasty value,
  // both within-position. A player with only one of the two carries that one.
  const combinedScores = new Map<string, number>();
  const scoredPids = new Set<string>([
    ...valueIndex.byPlayer.keys(),
    ...dynastyIndex.byPlayer.keys(),
  ]);
  for (const pid of scoredPids) {
    const v = valueIndex.byPlayer.get(pid)?.score ?? null;
    const d = dynastyIndex.byPlayer.get(pid)?.score ?? null;
    if (v !== null && d !== null) combinedScores.set(pid, Math.round((v + d) / 2));
    else if (v !== null) combinedScores.set(pid, v);
    else if (d !== null) combinedScores.set(pid, d);
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
    combinedScores,
    matchupIndex,
    pregameMatchupIndexes,
    residualModel,
    futureMatchups,
    playoff: format,
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
