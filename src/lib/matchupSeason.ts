import { buildMatchupIndex, type MatchupIndex } from './matchup';
import { buildTeamStats, type TeamStats } from './teamStats';
import type { ScoringModel } from './scoring';
import type { NflState, Player, StatLine } from './types';

export interface MatchupWeek {
  stats: Record<string, StatLine>;
  opponents: Record<string, string>;
  teams: Record<string, string>;
}

export function completedMatchupWeeks(season: string, state: NflState): number {
  if (Number(season) < Number(state.season)) return 18;
  if (season !== state.season || state.season_type === 'pre') return 0;
  if (state.season_type === 'post') return 18;
  return Math.max(0, Math.min(18, state.week - 1));
}

/** Keep early-season and historical previews on evidence available before kickoff. */
export function buildSeasonMatchupContext(input: {
  season: string;
  completedWeeks: number;
  beforeWeek: number;
  weeks: Map<number, MatchupWeek>;
  previousWeeks?: Map<number, MatchupWeek>;
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
}): { index: MatchupIndex; teamStats: Map<string, TeamStats> } {
  const throughWeek = Math.min(input.beforeWeek - 1, input.completedWeeks);
  const previousWeeks = throughWeek < 4 ? input.previousWeeks : undefined;
  const usePrevious = previousWeeks !== undefined;
  const weeks = previousWeeks ?? input.weeks;
  const sourceThroughWeek = usePrevious ? 18 : throughWeek;
  const index = buildMatchupIndex({
    scoringModel: input.scoringModel,
    playersById: input.playersById,
    weekStats: new Map([...weeks].map(([week, data]) => [week, data.stats])),
    weekOpponents: new Map([...weeks].map(([week, data]) => [week, data.opponents])),
    weekTeams: new Map([...weeks].map(([week, data]) => [week, data.teams])),
    throughWeek: sourceThroughWeek,
  });
  index.season = usePrevious ? String(Number(input.season) - 1) : input.season;
  return { index, teamStats: buildTeamStats(weeks, sourceThroughWeek + 1) };
}
