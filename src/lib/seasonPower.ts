/** Season scoring and weekly projections only; no player Value or dynasty inputs. */
import { mean } from './stats';

export const SEASON_POWER_WEIGHTS = {
  average: 0.5,
  recentAverage: 0.25,
  projection: 0.25,
} as const;

export interface SeasonPowerWeek {
  week: number;
  /** Null for unfinished weeks or missing results; a recorded zero is valid. */
  actual: number | null;
  projected: number | null;
}

export interface SeasonPowerInput {
  rosterId: number;
  weeks: SeasonPowerWeek[];
}

export interface SeasonPowerRanking {
  rosterId: number;
  rank: number | null;
  games: number;
  average: number | null;
  recentAverage: number | null;
  projection: number | null;
  /** Weighted points per week, with missing components omitted. */
  score: number | null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Rankings entering the selected week, without that week's eventual result. */
export function buildSeasonPowerRankings(teams: SeasonPowerInput[], week: number): SeasonPowerRanking[] {
  const rows = teams.map(({ rosterId, weeks }) => {
    const completed = weeks
      .flatMap((row) => {
        const actual = finite(row.actual);
        return row.week < week && actual !== null ? [{ week: row.week, actual }] : [];
      })
      .sort((a, b) => a.week - b.week);
    const scores = completed.map((row) => row.actual);
    const average = scores.length ? mean(scores) : null;
    const recentAverage = scores.length ? mean(scores.slice(-4)) : null;
    const projection = finite(weeks.find((row) => row.week === week)?.projected);
    const components = { average, recentAverage, projection };
    let weighted = 0;
    let weight = 0;
    for (const key of Object.keys(SEASON_POWER_WEIGHTS) as Array<keyof typeof SEASON_POWER_WEIGHTS>) {
      const value = components[key];
      if (value === null) continue;
      weighted += value * SEASON_POWER_WEIGHTS[key];
      weight += SEASON_POWER_WEIGHTS[key];
    }
    return { rosterId, games: scores.length, ...components, score: weight ? weighted / weight : null };
  }).sort((a, b) => {
    if (a.score === null) return b.score === null ? a.rosterId - b.rosterId : 1;
    if (b.score === null) return -1;
    return b.score - a.score || a.rosterId - b.rosterId;
  });

  let rank = 0;
  return rows.map((row, index) => {
    if (index === 0 || row.score !== rows[index - 1].score) rank = index + 1;
    return { ...row, rank: row.score === null ? null : rank };
  });
}
