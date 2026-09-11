/**
 * Forecast and simulation selectors.
 *
 * The models live in `lib/forecast.ts` and `lib/simulate.ts`; this file is the
 * seam where they meet real league data — picking the right lineup, the right
 * week's projections and the right slice of schedule, and memoizing the result
 * so a Monte Carlo run happens once per season load rather than once per render.
 */

import { buildWeekForecast, type PlayerForecast } from '../lib/forecast';
import {
  simulateSeason,
  simulateWeek,
  type SeasonSimulation,
  type SimTeam,
  type WeekSimulation,
} from '../lib/simulate';
import type { Matchup } from '../lib/types';
import { buildRosterWeek } from './selectors';
import { isOut, type LeagueData } from './league';
import { usesCurrentAvailability } from '../lib/availability';

/**
 * `live` locks current actual points for started players and samples players
 * yet to start. `pregame` ignores results for forecast comparisons and future
 * season simulations.
 */
export type ForecastMode = 'live' | 'pregame';

/** LeagueData is immutable once loaded, so every derived result is cacheable. */
const cache = new WeakMap<LeagueData, Map<string, unknown>>();

function memo<T>(data: LeagueData, key: string, build: () => T): T {
  let store = cache.get(data);
  if (!store) {
    store = new Map();
    cache.set(data, store);
  }
  if (store.has(key)) return store.get(key) as T;
  const value = build();
  store.set(key, value);
  return value;
}

export function weekForecasts(
  data: LeagueData,
  week: number,
  mode: ForecastMode = 'live',
): Map<string, PlayerForecast> {
  return memo(data, `forecast:${week}:${mode}`, () => {
    const weekData = data.weeks.get(week);

    /*
     * Injury status is reported as of *now*, not as of the week being viewed,
     * so applying it to a historical week would mark players out in weeks they
     * demonstrably played. It only carries information for the live week.
     */
    const liveWeek = usesCurrentAvailability(data.nflState, data.season, week);
    const startedTeams = new Set(data.nflSchedule
      .filter((game) => game.week === week && ['in_progress', 'complete', 'closed'].includes(game.status.toLowerCase()))
      .flatMap((game) => [game.home.toUpperCase(), game.away.toUpperCase()]));
    const rostered = data.teams.flatMap((team) => team.roster.players ?? []);

    return buildWeekForecast({
      model: data.residualModel,
      scoringModel: data.scoringModel,
      playersById: data.playersById,
      projections: weekData?.projections ?? data.futureProjections.get(week) ?? {},
      stats: mode === 'live' ? weekData?.stats : undefined,
      teams: weekData?.teams,
      isOut: liveWeek ? (pid) => isOut(data.playersById.get(pid)) : undefined,
      hasStarted: mode === 'live'
        ? (pid) => startedTeams.has((weekData?.teams[pid] ?? data.playersById.get(pid)?.team ?? '').toUpperCase())
        : undefined,
      only: new Set([
        ...rostered,
        ...Object.keys(weekData?.projections ?? data.futureProjections.get(week) ?? {}),
        ...Object.keys(weekData?.stats ?? {}),
        ...(weekData?.matchups ?? data.futureMatchups.get(week) ?? []).flatMap((matchup) => matchup.starters ?? []),
      ]),
      // Everyone projected, not just starters: the player sheet opens on free
      // agents too, and building the extra rows is a few milliseconds of
      // arithmetic against data already in memory.
    });
  });
}

/** Groups a week's matchup records into head-to-head pairs. */
function pairingsOf(matchups: Matchup[]): Array<{ matchupId: number; rosterIds: [number, number] }> {
  const byId = new Map<number, number[]>();
  for (const matchup of matchups) {
    if (matchup.matchup_id === null || matchup.matchup_id === undefined) continue;
    const bucket = byId.get(matchup.matchup_id);
    if (bucket) bucket.push(matchup.roster_id);
    else byId.set(matchup.matchup_id, [matchup.roster_id]);
  }

  return [...byId.entries()]
    .filter(([, rosterIds]) => rosterIds.length === 2)
    .map(([matchupId, rosterIds]) => ({
      matchupId,
      rosterIds: [rosterIds[0], rosterIds[1]] as [number, number],
    }));
}

function simTeams(data: LeagueData, week: number, mode: ForecastMode): SimTeam[] {
  const forecasts = weekForecasts(data, week, mode);
  return data.teams.map((team) => {
    const rosterWeek = buildRosterWeek(data, team.rosterId, week);
    return {
      rosterId: team.rosterId,
      starters: (rosterWeek?.starters ?? []).flatMap((player) => {
        const forecast = forecasts.get(player.pid);
        return forecast ? [forecast] : [];
      }),
    };
  });
}

/**
 * Win probability for one week's head-to-head games.
 *
 * Returns null when the week has no paired matchups — a playoff bye week, or a
 * season that hasn't been scheduled yet.
 */
export function weekOdds(
  data: LeagueData,
  week: number,
  mode: ForecastMode = 'live',
): WeekSimulation | null {
  return memo(data, `weekOdds:${week}:${mode}`, () => {
    const pairings = pairingsOf(data.weeks.get(week)?.matchups ?? data.futureMatchups.get(week) ?? []);
    if (!pairings.length) return null;

    return simulateWeek({
      teams: simTeams(data, week, mode),
      model: data.residualModel,
      pairings,
      // Seeded off the week so two weeks don't share a sample path, but a given
      // week always returns the same numbers.
      seed: 0x5c1a + week,
    });
  });
}

/**
 * Whether a week's games are all finished.
 *
 * Prefer the NFL game statuses: recording stats does not mean a live game has
 * finished. For a missing historical schedule, inspect the league's starters.
 */
export function weekIsComplete(data: LeagueData, week: number): boolean {
  const games = data.nflSchedule.filter((game) => game.week === week);
  if (games.length) return games.every((game) => ['complete', 'closed'].includes(game.status.toLowerCase()));
  if (data.season === data.nflState.season && data.nflState.season_type === 'regular' && week >= data.nflState.week) return false;
  let started = 0;

  for (const team of data.teams) {
    const rosterWeek = buildRosterWeek(data, team.rosterId, week);
    for (const player of rosterWeek?.starters ?? []) {
      started++;
      // Still to play: on the field, projected, and no stat line yet.
      if (!player.hasPlayed && !player.isOut && player.proj > 0) return false;
    }
  }

  return started > 0;
}

/**
 * Playoff, seed and title odds as of the start of `fromWeek`.
 *
 * Record and points carried in are the real ones through `fromWeek - 1`; every
 * week from there to the end of the regular season is simulated, then the
 * bracket is resolved under the league's own playoff format.
 */
export function seasonOdds(data: LeagueData, fromWeek: number): SeasonSimulation | null {
  return memo(data, `seasonOdds:${fromWeek}`, () => {
    const { regularSeasonWeeks, teams: playoffTeams, weeksPerRound } = data.playoff;

    // Banked record: replay every completed week before the starting point.
    const standing = new Map(
      data.teams.map((team) => [
        team.rosterId,
        { wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      ]),
    );

    for (let week = 1; week < Math.min(fromWeek, regularSeasonWeeks + 1); week++) {
      const matchups = data.weeks.get(week)?.matchups ?? [];
      const scoreOf = new Map(matchups.map((m) => [m.roster_id, m.points]));
      for (const { rosterIds } of pairingsOf(matchups)) {
        const [a, b] = rosterIds;
        const scoreA = scoreOf.get(a) ?? 0;
        const scoreB = scoreOf.get(b) ?? 0;
        const recordA = standing.get(a);
        const recordB = standing.get(b);
        if (!recordA || !recordB) continue;

        recordA.pointsFor += scoreA;
        recordB.pointsFor += scoreB;
        if (scoreA > scoreB) {
          recordA.wins++;
          recordB.losses++;
        } else if (scoreB > scoreA) {
          recordB.wins++;
          recordA.losses++;
        } else {
          recordA.ties++;
          recordB.ties++;
        }
      }
    }

    const remaining: Array<{ week: number; pairings: Array<[number, number]> }> = [];
    for (let week = fromWeek; week <= regularSeasonWeeks; week++) {
      const matchups = data.weeks.get(week)?.matchups ?? data.futureMatchups.get(week) ?? [];
      const pairings = pairingsOf(matchups).map(({ rosterIds }) => rosterIds);
      if (pairings.length) remaining.push({ week, pairings });
    }

    /*
     * The forward lineup is the one the team actually had at the starting week.
     * Past that we have no roster to read, so the most recent one stands in —
     * and the simulation's own docstring is explicit that a team's weekly
     * distribution is held fixed across the remaining schedule.
     */
    const referenceWeek = Math.max(1, Math.min(fromWeek, data.currentWeek));
    const teams = simTeams(data, referenceWeek, 'pregame');
    if (teams.every((team) => team.starters.length === 0)) return null;

    return simulateSeason({
      teams,
      model: data.residualModel,
      standing,
      remaining,
      playoffTeams,
      weeksPerRound,
      seed: 0x9e37 + fromWeek,
    });
  });
}
