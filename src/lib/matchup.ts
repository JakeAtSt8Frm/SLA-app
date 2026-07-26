/**
 * Matchup Score (0–100) — how good a defence is to face, by position group.
 *
 * For every (position group, defensive team) pair we measure how many custom
 * points that defence has surrendered to that group, then convert it into a
 * 0–100 defence-only rating where 100 means "the softest possible matchup".
 *
 * This matters far more in this league than in a standard one: with three DL,
 * four LB and three DB starting every week and IDP events weighted heavily
 * (a sack is 9 points, an interception 10), knowing which offences concede
 * defensive production is as valuable as knowing which defences concede
 * receiving yards.
 *
 * The rating blends six components:
 *   base          rank of generosity among all 32 defences (0–100)
 *   trend         recent 4-week direction vs season average, IQR-normalised
 *   ceiling bonus how often this defence allows a top-quartile week
 *   floor penalty how often it holds opponents to a bottom-quartile week
 *   consistency   inverse volatility — predictable defences are easier to trust
 *   top-10 bonus  how often it yields a leaguewide top-10 week at the position
 *
 * A player-facing lookup uses the two opponent-controlled signals that held up
 * against player projection residuals across 2023–2025: schedule-adjusted
 * concessions and opportunity volume allowed. Player/team strength is
 * deliberately excluded because it describes the player, not the matchup.
 */

import {
  createScorer,
  groupForPlayer,
  hasPlayed,
  opportunities,
  type ScoringModel,
} from './scoring';
import { clamp, mean, percentileRanks, quantile, round, stdev } from './stats';
import type { Player, PositionGroup, StatLine } from './types';
import { POSITION_GROUPS } from './types';

export interface MatchupBreakdown {
  base: number;
  trend: number;
  ceilingBonus: number;
  floorPenalty: number;
  consistencyBonus: number;
  top10Bonus: number;
}

export interface MatchupEntry {
  defense: string;
  group: PositionGroup;
  /** 0–100. Higher = more opportunity and adjusted production allowed. */
  score: number;
  /** Full defence-generosity composite used by the Analytics table. */
  baseScore: number;
  /** Percentile of schedule-adjusted points allowed. */
  opponentAdjustedScore: number;
  /** Percentile of opportunity volume allowed. */
  opportunityScore: number;
  /**
   * The unnormalised component sum, before rescaling.
   *
   * Exposed for transparency: `score` is this value's rank-percentile across
   * the league, not the sum itself. See the note on rescaling below.
   */
  rawComposite: number;
  /** Custom points per game allowed to this position group. */
  pointsPerGame: number;
  opponentAdjustedPpg: number;
  opportunitiesPerGame: number;
  efficiencyAllowed: number;
  last4: number;
  volatility: number;
  games: number;
  /** 1 = most generous defence in the league. */
  rankMostGenerous: number;
  ceilingRate: number;
  floorRate: number;
  top10Rate: number;
  breakdown: MatchupBreakdown;
}

export interface MatchupIndex {
  /** group -> defensive team -> entry */
  byGroup: Map<PositionGroup, Map<string, MatchupEntry>>;
  throughWeek: number;
  defenses: string[];
  get(
    group: PositionGroup | null,
    defense: string | null | undefined,
  ): MatchupEntry | null;
}

export interface BuildMatchupIndexInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** week -> pid -> stat line. Stat lines must carry `_opp` (see data layer). */
  weekStats: Map<number, Record<string, StatLine>>;
  /** week -> pid -> opponent team abbreviation. */
  weekOpponents: Map<number, Record<string, string>>;
  /** week -> pid -> player's team abbreviation. */
  weekTeams?: Map<number, Record<string, string>>;
  throughWeek: number;
}

export type MatchupHistoryInput = Omit<BuildMatchupIndexInput, 'throughWeek'>;

/** How many weekly performances count as "top N" for the top-10 bonus. */
const TOP_N = 10;
/** Player-facing matchup weights selected on leakage-safe player-week residuals. */
export const PLAYER_MATCHUP_WEIGHTS = {
  opponentAdjusted: 0.6,
  opportunity: 0.4,
} as const;

export function buildMatchupIndex(input: BuildMatchupIndexInput): MatchupIndex {
  const { scoringModel, playersById, weekStats, weekOpponents, weekTeams, throughWeek } = input;
  const score = createScorer(scoringModel);

  // group -> defense -> list of per-player-week scores conceded
  const conceded = new Map<PositionGroup, Map<string, number[]>>();
  // group -> defense -> Set of weeks faced (a defence plays once a week)
  const gamesFaced = new Map<PositionGroup, Map<string, Set<number>>>();
  // group -> defense -> count of top-N weekly performances allowed
  const top10 = new Map<PositionGroup, Map<string, number>>();
  // group -> defense -> per-week totals conceded, for trend/volatility
  const weeklyTotals = new Map<PositionGroup, Map<string, Map<number, number>>>();
  // group -> opponent -> per-week opportunity volume allowed
  const weeklyOpportunities = new Map<PositionGroup, Map<string, Map<number, number>>>();
  // group -> opponent -> week -> team producing the points
  const weeklySourceTeams = new Map<PositionGroup, Map<string, Map<number, string>>>();
  // group -> source team -> per-week points produced
  const teamWeeklyTotals = new Map<PositionGroup, Map<string, Map<number, number>>>();

  for (const group of POSITION_GROUPS) {
    conceded.set(group, new Map());
    gamesFaced.set(group, new Map());
    top10.set(group, new Map());
    weeklyTotals.set(group, new Map());
    weeklyOpportunities.set(group, new Map());
    weeklySourceTeams.set(group, new Map());
    teamWeeklyTotals.set(group, new Map());
  }

  const nested = <T>(m: Map<PositionGroup, Map<string, T>>, g: PositionGroup, d: string, init: () => T): T => {
    const inner = m.get(g)!;
    let v = inner.get(d);
    if (v === undefined) {
      v = init();
      inner.set(d, v);
    }
    return v;
  };

  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    if (!stats) continue;
    const opponents = weekOpponents.get(week) ?? {};
    const teams = weekTeams?.get(week) ?? {};

    // Collect this week's performances so we can find the top-N per group.
    const weekRows: Array<{
      group: PositionGroup;
      defense: string;
      sourceTeam: string;
      points: number;
      opportunities: number;
    }> = [];

    for (const pid of Object.keys(stats)) {
      const line = stats[pid];
      if (!hasPlayed(line)) continue;

      const group = groupForPlayer(playersById.get(pid));
      if (!group) continue;

      const defense = opponents[pid];
      if (!defense) continue;
      const sourceTeam = teams[pid] ?? '';
      const points = score(line);
      const volume = opportunities(group, line) ?? 0;

      weekRows.push({ group, defense, sourceTeam, points, opportunities: volume });
    }

    // Per-group top-N for this week.
    const byGroupRows = new Map<PositionGroup, typeof weekRows>();
    for (const row of weekRows) {
      const arr = byGroupRows.get(row.group);
      if (arr) arr.push(row);
      else byGroupRows.set(row.group, [row]);
    }

    for (const [group, rows] of byGroupRows) {
      const ranked = [...rows].sort((a, b) => b.points - a.points).slice(0, TOP_N);
      for (const row of ranked) {
        const counter = top10.get(group)!;
        counter.set(row.defense, (counter.get(row.defense) ?? 0) + 1);
      }
    }

    for (const row of weekRows) {
      nested(conceded, row.group, row.defense, () => [] as number[]).push(row.points);
      nested(gamesFaced, row.group, row.defense, () => new Set<number>()).add(week);

      const wk = nested(weeklyTotals, row.group, row.defense, () => new Map<number, number>());
      wk.set(week, (wk.get(week) ?? 0) + row.points);

      const volume = nested(
        weeklyOpportunities,
        row.group,
        row.defense,
        () => new Map<number, number>(),
      );
      volume.set(week, (volume.get(week) ?? 0) + row.opportunities);

      if (row.sourceTeam) {
        const sources = nested(
          weeklySourceTeams,
          row.group,
          row.defense,
          () => new Map<number, string>(),
        );
        sources.set(week, row.sourceTeam);

        const teamTotals = nested(
          teamWeeklyTotals,
          row.group,
          row.sourceTeam,
          () => new Map<number, number>(),
        );
        teamTotals.set(week, (teamTotals.get(week) ?? 0) + row.points);
      }
    }
  }

  // ---- Convert raw concessions into 0–100 ratings --------------------------

  const byGroup = new Map<PositionGroup, Map<string, MatchupEntry>>();
  const defenseSet = new Set<string>();

  for (const group of POSITION_GROUPS) {
    const perDefense = weeklyTotals.get(group)!;
    if (!perDefense.size) {
      byGroup.set(group, new Map());
      continue;
    }

    const teamStrengthRows = [...teamWeeklyTotals.get(group)!.entries()].map(
      ([team, totals]) => ({
        id: team,
        value: mean([...totals.values()]),
      }),
    );
    const allWeeklyTotals = [...perDefense.values()].flatMap((weekMap) => [
      ...weekMap.values(),
    ]);
    const leagueWeeklyMean = mean(allWeeklyTotals);
    const teamStrength = new Map(teamStrengthRows.map((row) => [row.id, row.value]));

    // League-wide distribution of individual performances against this group,
    // used to define what counts as a ceiling or floor week.
    const allPerformances: number[] = [];
    for (const list of conceded.get(group)!.values()) allPerformances.push(...list);
    const p25 = quantile(allPerformances, 0.25);
    const p75 = quantile(allPerformances, 0.75);
    const iqr = Math.max(p75 - p25, 1e-6);

    interface Row {
      defense: string;
      ppg: number;
      last4: number;
      volatility: number;
      games: number;
      ceilingRate: number;
      floorRate: number;
      top10Rate: number;
      opponentAdjustedPpg: number;
      opportunitiesPerGame: number;
      efficiencyAllowed: number;
    }

    const rows: Row[] = [];

    for (const [defense, weekMap] of perDefense) {
      defenseSet.add(defense);
      const weeks = [...weekMap.keys()].sort((a, b) => a - b);
      const totals = weeks.map((w) => weekMap.get(w)!);
      const games = weeks.length;
      if (!games) continue;

      const ppg = mean(totals);
      const last4Weeks = totals.slice(-4);
      const last4 = last4Weeks.length ? mean(last4Weeks) : ppg;
      const volatility = stdev(totals);
      const volumeMap = weeklyOpportunities.get(group)!.get(defense) ?? new Map();
      const opportunitiesPerGame = mean(weeks.map((week) => volumeMap.get(week) ?? 0));
      const sourceMap = weeklySourceTeams.get(group)!.get(defense) ?? new Map();
      const adjustedTotals = weeks.map((week) => {
        const source = sourceMap.get(week);
        const sourceStrength = source ? teamStrength.get(source) : undefined;
        return weekMap.get(week)! - ((sourceStrength ?? leagueWeeklyMean) - leagueWeeklyMean);
      });
      const opponentAdjustedPpg = mean(adjustedTotals);

      // Ceiling/floor rates measured over individual performances allowed.
      const performances = conceded.get(group)!.get(defense) ?? [];
      let ceilCount = 0;
      let floorCount = 0;
      for (const p of performances) {
        if (p >= p75) ceilCount++;
        if (p <= p25) floorCount++;
      }

      rows.push({
        defense,
        ppg,
        last4,
        volatility,
        games,
        ceilingRate: performances.length ? ceilCount / performances.length : 0,
        floorRate: performances.length ? floorCount / performances.length : 0,
        top10Rate: games ? (top10.get(group)!.get(defense) ?? 0) / games : 0,
        opponentAdjustedPpg,
        opportunitiesPerGame,
        efficiencyAllowed: ppg / Math.max(opportunitiesPerGame, 1),
      });
    }

    // Rank 1 = most generous (concedes the most points to this group).
    const ranked = [...rows].sort((a, b) => b.ppg - a.ppg);
    const rankOf = new Map<string, number>();
    ranked.forEach((r, i) => rankOf.set(r.defense, i + 1));

    const n = rows.length;
    const entries = new Map<string, MatchupEntry>();
    const adjustedRanks = percentileRanks(
      rows.map((row) => ({ id: row.defense, value: row.opponentAdjustedPpg })),
    );
    const opportunityRanks = percentileRanks(
      rows.map((row) => ({ id: row.defense, value: row.opportunitiesPerGame })),
    );

    // First compute the raw composite for every defence in this group.
    const composites: Array<{ id: string; value: number; parts: MatchupBreakdown }> = [];

    for (const r of rows) {
      const rank = rankOf.get(r.defense)!;

      // Base: linear over rank so the most generous defence starts at 100.
      const base = n > 1 ? (100 * (n - rank)) / (n - 1) : 50;

      // Trend: positive means the defence has been getting softer lately.
      const trend = ((r.last4 - r.ppg) / iqr) * 10;

      const ceilingBonus = r.ceilingRate * 15;
      const floorPenalty = r.floorRate * 10;
      // Lower volatility relative to output = more predictable = slight bonus.
      const consistencyBonus = (1 - Math.min(r.volatility / (r.ppg || 1), 1)) * 10;
      const top10Bonus = r.top10Rate * 20;

      composites.push({
        id: r.defense,
        value: base + trend + ceilingBonus - floorPenalty + consistencyBonus + top10Bonus,
        parts: {
          base: round(base, 1),
          trend: round(trend, 1),
          ceilingBonus: round(ceilingBonus, 1),
          floorPenalty: round(floorPenalty, 1),
          consistencyBonus: round(consistencyBonus, 1),
          top10Bonus: round(top10Bonus, 1),
        },
      });
    }

    /*
     * Rescale rather than clamp.
     *
     * The component sum ranges roughly -10..155: base alone reaches 100 for the
     * most generous defence, and the bonuses can add another 55 on top. Clamping
     * that into 0..100 flattened the extremes — in 2025 three different defences
     * tied at exactly 100.0 against QBs and two sat at 0.0, which destroyed the
     * ordering precisely where it matters most, at the softest and toughest
     * matchups a manager is actually choosing between.
     *
     * Mapping the composite onto its own rank-percentile keeps every component's
     * influence on the ordering, guarantees a full 0..100 spread, and makes the
     * number mean something concrete for the defence-only baseline:
     * "softer than X% of the league".
     */
    const rescaled = percentileRanks(composites.map(({ id, value }) => ({ id, value })));
    const compositeById = new Map(composites.map((c) => [c.id, c]));

    for (const r of rows) {
      const composite = compositeById.get(r.defense)!;
      const total = clamp((rescaled.get(r.defense) ?? 0.5) * 100, 0, 100);
      const opponentAdjustedScore = (adjustedRanks.get(r.defense) ?? 0.5) * 100;
      const opportunityScore = (opportunityRanks.get(r.defense) ?? 0.5) * 100;

      entries.set(r.defense, {
        defense: r.defense,
        group,
        score: round(total, 1),
        baseScore: round(total, 1),
        opponentAdjustedScore: round(opponentAdjustedScore, 1),
        opportunityScore: round(opportunityScore, 1),
        rawComposite: round(composite.value, 1),
        pointsPerGame: round(r.ppg),
        opponentAdjustedPpg: round(r.opponentAdjustedPpg),
        opportunitiesPerGame: round(r.opportunitiesPerGame),
        efficiencyAllowed: round(r.efficiencyAllowed, 3),
        last4: round(r.last4),
        volatility: round(r.volatility),
        games: r.games,
        rankMostGenerous: rankOf.get(r.defense)!,
        ceilingRate: round(r.ceilingRate, 3),
        floorRate: round(r.floorRate, 3),
        top10Rate: round(r.top10Rate, 3),
        breakdown: composite.parts,
      });
    }

    byGroup.set(group, entries);
  }

  return {
    byGroup,
    throughWeek,
    defenses: [...defenseSet].sort(),
    get(group, defense) {
      if (!group || !defense) return null;
      const entry = byGroup.get(group)?.get(String(defense).toUpperCase()) ?? null;
      if (!entry) return null;
      const playerScore =
        entry.opponentAdjustedScore * PLAYER_MATCHUP_WEIGHTS.opponentAdjusted +
        entry.opportunityScore * PLAYER_MATCHUP_WEIGHTS.opportunity;

      return {
        ...entry,
        score: round(clamp(playerScore, 0, 100), 1),
      };
    },
  };
}

/**
 * Builds the rating that was knowable before each historical week.
 *
 * A season-wide index is appropriate for today's Analytics table, but using it
 * on Week 4 would leak Week 4 and all later results into that player's chip.
 */
export function buildPregameMatchupIndexes(
  input: MatchupHistoryInput,
  maxWeek: number,
): Map<number, MatchupIndex> {
  const indexes = new Map<number, MatchupIndex>();
  for (let week = 1; week <= maxWeek; week++) {
    indexes.set(
      week,
      buildMatchupIndex({
        ...input,
        throughWeek: week - 1,
      }),
    );
  }
  return indexes;
}
