import { buildSeasonPowerRankings, type SeasonPowerRanking, type SeasonPowerWeek } from '../lib/seasonPower';
import { availabilityFactors } from '../lib/availability';
import { groupForPlayer, hasPlayed } from '../lib/scoring';
import { round } from '../lib/stats';
import type { PositionGroup } from '../lib/types';
import type { LeagueData } from './league';
import { buildRosterWeek } from './selectors';

/**
 * Projected regular-season total per team: completed weeks at their real
 * result, remaining weeks at today's lineup against that week's own projection.
 *
 * Remaining weeks are discounted by `availabilityFactors().season`, the app's
 * existing policy for how much of a player's in-season value survives their
 * current NFL status — practice squad, free agent, reserve, suspended, retired,
 * and the injury designations. Reusing it keeps one availability policy in the
 * app rather than inventing a second one that could disagree with the player
 * sheet. It already folds in the estimated return window, so no separate
 * per-week injury timeline is applied on top.
 */
export function seasonPowerRankings(data: LeagueData, scope: 'ALL' | PositionGroup = 'ALL'): SeasonPowerRanking[] {
  const liveSeason = data.nflState.season === data.season;
  let completedThrough = data.currentWeek;
  if (liveSeason && data.nflState.season_type === 'regular') {
    completedThrough = Math.min(data.currentWeek, data.nflState.week - 1);
  } else if (liveSeason && data.nflState.season_type !== 'post') {
    completedThrough = 0;
  }

  const lastWeek = data.playoff.regularSeasonWeeks;
  const observedWeeks = new Set(
    [...data.weeks]
      .filter(([number, payload]) => number <= Math.min(completedThrough, lastWeek)
        && Object.values(payload.stats).some(hasPlayed))
      .map(([number]) => number),
  );

  return buildSeasonPowerRankings(data.teams.map((team) => {
    const weeks: SeasonPowerWeek[] = [];

    for (const number of observedWeeks) {
      const roster = buildRosterWeek(data, team.rosterId, number);
      if (!roster?.starters.length) continue;
      // Historical results require that week's lineup; today's lineup cannot
      // silently fill a hole. Explicit roster-season overrides are replay views.
      const hasLineup = data.rostersOverridden
        || !!data.weeks.get(number)?.matchups.some((matchup) => matchup.roster_id === team.rosterId && matchup.starters?.length);
      if (!hasLineup) continue;
      // Group by football position, so a QB in a superflex slot still counts
      // toward QB power. An unfilled position contributes zero, not a bye.
      const starters = scope === 'ALL' ? roster.starters : roster.starters.filter((player) => player.group === scope);
      weeks.push({
        week: number,
        actual: round(starters.reduce((total, player) => total + player.act, 0)),
        projected: null,
      });
    }

    // Weeks still to play, including the live one: today's starters, each
    // week's own projection, discounted for availability.
    const startersToday = (team.roster.starters ?? [])
      .map((pid) => String(pid ?? ''))
      .filter((pid) => pid && pid !== '0');

    for (let number = 1; number <= lastWeek; number++) {
      if (observedWeeks.has(number)) continue;
      const projections = number <= data.maxWeek
        ? data.weeks.get(number)?.projections
        : data.futureProjections.get(number);
      if (!projections) continue;

      // Having the week's projections is what makes it forecastable; a scope
      // whose starters project nothing forecasts zero, exactly as an unfilled
      // position scores zero in a week already played.
      let total = 0;
      for (const pid of startersToday) {
        const player = data.playersById.get(pid);
        if (scope !== 'ALL' && groupForPlayer(player) !== scope) continue;
        const base = data.score(projections[pid]);
        if (base <= 0) continue;
        total += base * availabilityFactors(player).season;
      }
      weeks.push({ week: number, actual: null, projected: round(total) });
    }

    return { rosterId: team.rosterId, weeks };
  }));
}
