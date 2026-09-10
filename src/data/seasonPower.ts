import { buildSeasonPowerRankings, type SeasonPowerRanking, type SeasonPowerWeek } from '../lib/seasonPower';
import { hasPlayed, hasValidProjection } from '../lib/scoring';
import type { LeagueData } from './league';
import { buildRosterWeek } from './selectors';

/** Reuse custom-scored lineups, keeping current availability on live projections. */
export function seasonPowerRankings(data: LeagueData, week: number): SeasonPowerRanking[] {
  const liveSeason = data.nflState.season === data.season;
  let completedThrough = data.currentWeek;
  if (liveSeason && data.nflState.season_type === 'regular') {
    completedThrough = Math.min(data.currentWeek, data.nflState.week - 1);
  } else if (liveSeason && data.nflState.season_type !== 'post') {
    completedThrough = 0;
  }
  const observedWeeks = new Set(
    [...data.weeks].filter(([number, payload]) => number < week && number <= completedThrough
      && Object.values(payload.stats).some(hasPlayed)).map(([number]) => number),
  );

  return buildSeasonPowerRankings(data.teams.map((team) => {
    const weeks: SeasonPowerWeek[] = [];
    for (const number of [...observedWeeks, week]) {
      const roster = buildRosterWeek(data, team.rosterId, number);
      if (!roster?.starters.length) continue;
      // Historical results require that week's lineup; today's lineup cannot
      // silently fill a hole. Explicit roster-season overrides are replay views.
      const hasLineup = data.rostersOverridden ||
        !!data.weeks.get(number)?.matchups.some((matchup) => matchup.roster_id === team.rosterId && matchup.starters?.length);
      const projections = data.weeks.get(number)?.projections;
      const hasProjection = number === week && roster.starters.some((player) => hasValidProjection(projections?.[player.pid]));
      weeks.push({
        week: number,
        actual: observedWeeks.has(number) && hasLineup ? roster.actualTotal : null,
        projected: hasProjection ? roster.projectedTotal : null,
      });
    }
    return { rosterId: team.rosterId, weeks };
  }), week);
}
