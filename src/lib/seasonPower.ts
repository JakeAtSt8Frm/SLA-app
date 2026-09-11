/**
 * Full-season power: what a team has banked, plus what it is projected to add.
 *
 * Ranks on the projected regular-season total — points already scored in
 * completed weeks plus the projected score of every week still to play. That
 * makes the number a forecast of where the season ends rather than a reading of
 * current form, so a team that has banked a lead keeps it, and a team whose
 * roster has fallen apart stops being flattered by weeks it already won.
 *
 * Season scoring and weekly projections only; no player Value or dynasty inputs.
 */

export interface SeasonPowerWeek {
  week: number;
  /**
   * Result of a completed week. Null for a week not yet played or missing a
   * lineup; a recorded zero is a real result and counts.
   */
  actual: number | null;
  /** Projected score for a week still to play. Ignored once `actual` exists. */
  projected: number | null;
}

export interface SeasonPowerInput {
  rosterId: number;
  weeks: SeasonPowerWeek[];
}

export interface SeasonPowerRanking {
  rosterId: number;
  rank: number | null;
  /** Completed weeks and the points banked in them. */
  playedWeeks: number;
  played: number;
  /** Weeks still to play and their projected points, after availability. */
  remainingWeeks: number;
  projected: number;
  /** The ranking key: played + projected over the whole regular season. */
  total: number | null;
  /** Total over every week counted, so short and full seasons compare. */
  perWeek: number | null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Ranks teams on their projected full regular-season total. */
export function buildSeasonPowerRankings(teams: SeasonPowerInput[]): SeasonPowerRanking[] {
  const rows = teams
    .map(({ rosterId, weeks }) => {
      let played = 0;
      let playedWeeks = 0;
      let projected = 0;
      let remainingWeeks = 0;

      for (const row of weeks) {
        // A played week is settled: its projection is history and never counted
        // alongside the result it was trying to predict.
        const actual = finite(row.actual);
        if (actual !== null) {
          played += actual;
          playedWeeks++;
          continue;
        }
        const forecast = finite(row.projected);
        if (forecast === null) continue;
        projected += forecast;
        remainingWeeks++;
      }

      const counted = playedWeeks + remainingWeeks;
      const total = counted ? played + projected : null;
      return {
        rosterId,
        playedWeeks,
        played,
        remainingWeeks,
        projected,
        total,
        perWeek: total === null ? null : total / counted,
      };
    })
    .sort((a, b) => {
      if (a.total === null) return b.total === null ? a.rosterId - b.rosterId : 1;
      if (b.total === null) return -1;
      return b.total - a.total || a.rosterId - b.rosterId;
    });

  let rank = 0;
  return rows.map((row, index) => {
    if (index === 0 || row.total !== rows[index - 1].total) rank = index + 1;
    return { ...row, rank: row.total === null ? null : rank };
  });
}
