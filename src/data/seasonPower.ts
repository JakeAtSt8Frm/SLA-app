import { buildSeasonPowerRankings, type SeasonPowerRanking, type SeasonPowerWeek } from '../lib/seasonPower';
import { hasPlayed, hasValidProjection } from '../lib/scoring';
import { round } from '../lib/stats';
import type { PositionGroup } from '../lib/types';
import type { LeagueData } from './league';
import { buildRosterWeek } from './selectors';

/** Reuse custom-scored lineups, keeping current availability on live projections. */
export function seasonPowerRankings(data: LeagueData, week: number, scope: 'ALL' | PositionGroup = 'ALL'): SeasonPowerRanking[] {
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
      // Group by football position, so a QB in a superflex slot still counts
      // toward QB power. An unfilled position contributes zero, not a bye.
      const starters = scope === 'ALL' ? roster.starters : roster.starters.filter((player) => player.group === scope);
      const projections = data.weeks.get(number)?.projections;
      const hasProjection = number === week && (starters.length ? starters : roster.starters)
        .some((player) => hasValidProjection(projections?.[player.pid]));
      weeks.push({
        week: number,
        actual: observedWeeks.has(number) && hasLineup ? round(starters.reduce((total, player) => total + player.act, 0)) : null,
        projected: hasProjection ? round(starters.reduce((total, player) => total + player.proj, 0)) : null,
      });
    }
    return { rosterId: team.rosterId, weeks };
  }), week);
}
