/**
 * Player Value Score (0–1000).
 *
 * A season-long, in-season valuation of a player built entirely from custom-
 * scored production. The model blends 18 normalised signals, every one of which
 * is a percentile *within the player's own position group* — a 900-value LB and
 * a 900-value WR are both "top of their pool", not comparable in raw points.
 *
 * Design rules carried over from the original model, and worth preserving:
 *  - On-field production dominates. Rank-based terms carry the most weight.
 *  - Reliability (availability, consistency, floor) refines the score.
 *  - Market signal is deliberately tiny — it's a tie-breaker, not a driver.
 *  - Age is excluded: this is an in-season value model, not a dynasty ranking.
 *  - Small samples are blended toward neutral rather than crushed to zero.
 */

import {
  createScorer,
  efficiency,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
  opportunities,
  snapPct,
  type ScoringModel,
} from './scoring';
import { clamp01, percentileRanks, quantile, rankScore, round, stdev } from './stats';
import type { Player, PositionGroup, RankInfo, ResearchEntry, StatLine } from './types';

/** Weights applied to the normalised 0..1 signals. These sum to ~1.0. */
export const VALUE_WEIGHTS = {
  ppgRank: 0.18, // PPG rank within position group — highest priority
  totalRank: 0.14, // Total-points rank — durability context
  ppg: 0.055, // Raw PPG percentile
  total: 0.045, // Raw total-points percentile
  last8: 0.08, // Recent production window
  recency: 0.035, // Last-8 vs season momentum (sample-adjusted)
  availability: 0.08, // Share of weeks actually played
  consistency: 0.06, // Low week-to-week volatility
  floor: 0.04, // 25th-percentile week
  ceiling: 0.03, // 85th-percentile week
  boomBust: 0.02, // Boom rate minus bust rate
  delta: 0.03, // Outperformance vs projection
  usage: 0.05, // Opportunity volume
  efficiency: 0.04, // Points per opportunity
  market: 0.005, // Ownership/start rate — tiny tie-breaker
  usageTrend: 0.015, // Direction of recent volume
  last4: 0.01, // Very recent short window
  snaps: 0.015, // Snap share
} as const;

/** Boom/bust thresholds. Configurable in settings; these are the defaults. */
export interface BoomBustConfig {
  boomPct: number;
  bustPct: number;
}

export const DEFAULT_BOOM_BUST: BoomBustConfig = { boomPct: 1.2, bustPct: 0.8 };

export interface ValueBreakdown {
  group: PositionGroup;
  games: number;
  ppg: number;
  total: number;
  last4: number;
  last8: number;
  availability: number;
  consistency: number;
  floor: number;
  ceiling: number;
  boomRate: number;
  bustRate: number;
  deltaAvg: number;
  deltaBeatRate: number;
  usagePerGame: number | null;
  usageTrend: number;
  efficiency: number | null;
  snapPct: number | null;
  ownedPct: number | null;
  startedPct: number | null;
  /** Confidence multiplier applied for small samples (0.45..1.0). */
  gamesConfidence: number;
  /** Per-term contributions, for the "why this score" panel. */
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface PlayerValue {
  pid: string;
  score: number;
  group: PositionGroup;
  breakdown: ValueBreakdown;
}

export interface ValueIndex {
  byPlayer: Map<string, PlayerValue>;
  ppgRanks: Map<string, RankInfo>;
  totalRanks: Map<string, RankInfo>;
  /** Per-player, per-week custom scores — reused by charts and history. */
  weeklyScores: Map<string, Array<{ week: number; actual: number; projected: number | null }>>;
  seasonTotals: Map<string, number>;
}

interface Accumulator {
  total: number;
  games: number;
  weekScores: number[];
  weeklyDetail: Array<{ week: number; actual: number; projected: number | null }>;
  lastActs: number[];
  boom: number;
  bust: number;
  projGames: number;
  deltaSum: number;
  deltaBeat: number;
  deltaN: number;
  snapSum: number;
  snapN: number;
  oppSum: number;
  oppN: number;
  oppSeries: number[];
  effSum: number;
  effN: number;
}

function newAccumulator(): Accumulator {
  return {
    total: 0,
    games: 0,
    weekScores: [],
    weeklyDetail: [],
    lastActs: [],
    boom: 0,
    bust: 0,
    projGames: 0,
    deltaSum: 0,
    deltaBeat: 0,
    deltaN: 0,
    snapSum: 0,
    snapN: 0,
    oppSum: 0,
    oppN: 0,
    oppSeries: [],
    effSum: 0,
    effN: 0,
  };
}

export interface BuildValueIndexInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** week number -> pid -> stat line */
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  /** Current-week ownership data, optional. */
  research?: Record<string, ResearchEntry> | null;
  throughWeek: number;
  config?: BoomBustConfig;
}

/**
 * Builds the full value index for a season in a single pass over week stats.
 *
 * This is the most expensive computation in the app (roughly 2000 players x 18
 * weeks), so it runs once per season load and every page reads from the result.
 */
export function buildValueIndex(input: BuildValueIndexInput): ValueIndex {
  const {
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    research,
    throughWeek,
    config = DEFAULT_BOOM_BUST,
  } = input;

  const score = createScorer(scoringModel);
  const agg = new Map<string, Accumulator>();

  // ---- Pass 1: accumulate per-player season aggregates ---------------------
  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    if (!stats) continue;
    const projections = weekProjections.get(week) ?? {};

    for (const pid of Object.keys(stats)) {
      const line = stats[pid];
      if (!hasPlayed(line)) continue;

      const player = playersById.get(pid);
      const group = groupForPlayer(player);
      if (!group) continue;

      let a = agg.get(pid);
      if (!a) {
        a = newAccumulator();
        agg.set(pid, a);
      }

      const actual = score(line);
      a.total += actual;
      a.games += 1;
      a.weekScores.push(actual);

      // Keep a rolling last-8 window for recency weighting.
      a.lastActs.push(actual);
      if (a.lastActs.length > 8) a.lastActs.shift();

      // Projection-derived signals only count when a real projection exists,
      // otherwise every unprojected week would register as a boom.
      const projLine = projections[pid];
      const projected = hasValidProjection(projLine) ? score(projLine) : null;
      a.weeklyDetail.push({ week, actual, projected });

      if (projected !== null && projected > 0) {
        a.projGames += 1;
        a.deltaSum += actual - projected;
        a.deltaN += 1;
        if (actual > projected) a.deltaBeat += 1;
        if (actual >= projected * config.boomPct) a.boom += 1;
        else if (actual <= projected * config.bustPct) a.bust += 1;
      }

      const snaps = snapPct(line);
      if (snaps !== null) {
        a.snapSum += snaps;
        a.snapN += 1;
      }

      const opps = opportunities(group, line);
      if (opps !== null) {
        a.oppSum += opps;
        a.oppN += 1;
        a.oppSeries.push(opps);
      }

      const eff = efficiency(group, line, actual);
      if (eff !== null) {
        a.effSum += eff;
        a.effN += 1;
      }
    }
  }

  // ---- Pass 2: derive per-player metrics -----------------------------------
  interface Derived {
    pid: string;
    group: PositionGroup;
    games: number;
    total: number;
    ppg: number;
    last4: number;
    last8: number;
    recencyAdj: number;
    availability: number;
    floor: number;
    ceiling: number;
    consistency: number;
    boomRate: number;
    bustRate: number;
    boomBustAdj: number;
    snapAdj: number;
    snapRaw: number | null;
    oppPerGame: number | null;
    oppTrend: number;
    effAvg: number | null;
    marketAdj: number;
    owned: number | null;
    started: number | null;
    deltaAvg: number;
    deltaBeatRate: number;
    deltaBeatAdj: number;
  }

  const derived = new Map<string, Derived>();
  const byGroup = new Map<PositionGroup, string[]>();

  for (const [pid, a] of agg) {
    if (!a.games) continue;
    const player = playersById.get(pid);
    const group = groupForPlayer(player);
    if (!group) continue;

    const ppg = a.total / a.games;

    const recent4 = a.lastActs.slice(-4);
    const last4 = recent4.length ? recent4.reduce((x, y) => x + y, 0) / recent4.length : ppg;
    const last8 = a.lastActs.length
      ? a.lastActs.reduce((x, y) => x + y, 0) / a.lastActs.length
      : ppg;

    // Momentum, pulled toward neutral when the recent sample is thin.
    const recentSample = clamp01(a.lastActs.length / 8);
    const recencyRatio = ppg > 0 ? last8 / ppg : 1;
    const recencyNorm = clamp01((recencyRatio - 0.75) / 0.5); // 0.75x -> 0, 1.25x -> 1
    const recencyAdj = 0.5 + (recencyNorm - 0.5) * recentSample;

    const availability = throughWeek > 0 ? clamp01(a.games / throughWeek) : 0;
    const floor = quantile(a.weekScores, 0.25);
    const ceiling = quantile(a.weekScores, 0.85);

    // Coefficient of variation -> consistency. cv >= 1 collapses to 0.
    const sd = stdev(a.weekScores);
    const cv = ppg > 0 ? sd / (ppg + 1e-6) : 0;
    const consistency = clamp01(1 - cv);

    const boomRate = a.projGames > 0 ? a.boom / a.projGames : 0;
    const bustRate = a.projGames > 0 ? a.bust / a.projGames : 0;
    const boomBustAdj = a.projGames > 0 ? clamp01((boomRate - bustRate + 1) / 2) : 0.5;

    const snapRaw = a.snapN > 0 ? a.snapSum / a.snapN : null;
    const snapAdj = snapRaw === null ? 0.5 : clamp01(snapRaw / 100);

    const oppPerGame = a.oppN > 0 ? a.oppSum / a.oppN : null;
    let oppTrend = 0;
    if (oppPerGame !== null && oppPerGame > 0 && a.oppSeries.length >= 2) {
      const last2 = a.oppSeries.slice(-2);
      const lastAvg = last2.reduce((x, y) => x + y, 0) / last2.length;
      oppTrend = (lastAvg - oppPerGame) / Math.max(1, oppPerGame);
    }

    const effAvg = a.effN > 0 ? a.effSum / a.effN : null;

    // Market context from Sleeper's research endpoint. Start% preferred over
    // ownership% because it reflects active manager confidence this week.
    const r = research?.[pid];
    const owned = typeof r?.owned === 'number' ? r.owned : null;
    const started = typeof r?.started === 'number' ? r.started : null;
    const marketAdj =
      started !== null ? clamp01(started / 100) : owned !== null ? clamp01(owned / 100) : 0.5;

    const deltaAvg = a.deltaN > 0 ? a.deltaSum / a.deltaN : 0;
    const deltaBeatRate = a.deltaN > 0 ? a.deltaBeat / a.deltaN : 0;
    // Bayesian shrinkage toward 50% damps small-sample beat rates.
    const DELTA_PRIOR = 6;
    const deltaBeatAdj =
      a.deltaN > 0 ? (a.deltaBeat + DELTA_PRIOR * 0.5) / (a.deltaN + DELTA_PRIOR) : 0.5;

    derived.set(pid, {
      pid,
      group,
      games: a.games,
      total: a.total,
      ppg,
      last4,
      last8,
      recencyAdj,
      availability,
      floor,
      ceiling,
      consistency,
      boomRate,
      bustRate,
      boomBustAdj,
      snapAdj,
      snapRaw,
      oppPerGame,
      oppTrend,
      effAvg,
      marketAdj,
      owned,
      started,
      deltaAvg,
      deltaBeatRate,
      deltaBeatAdj,
    });

    const bucket = byGroup.get(group);
    if (bucket) bucket.push(pid);
    else byGroup.set(group, [pid]);
  }

  // ---- Pass 3: rank and percentile within each position group --------------

  // A dynamic games threshold keeps early-season ranks from being dominated by
  // one-week wonders without being so strict that nobody qualifies in week 3.
  const minGamesForRank = Math.min(6, Math.max(3, Math.floor(throughWeek * 0.55)));

  const ppgRanks = new Map<string, RankInfo>();
  const totalRanks = new Map<string, RankInfo>();
  const groupCounts = new Map<PositionGroup, { ppg: number; total: number }>();

  for (const [group, pids] of byGroup) {
    const ppgEligible = pids
      .map((pid) => derived.get(pid)!)
      .filter((d) => d.games >= minGamesForRank)
      .sort((a, b) => b.ppg - a.ppg);

    ppgEligible.forEach((d, i) => {
      ppgRanks.set(d.pid, {
        group,
        rank: i + 1,
        outOf: ppgEligible.length,
        value: round(d.ppg),
      });
    });

    const totalEligible = pids
      .map((pid) => derived.get(pid)!)
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total);

    totalEligible.forEach((d, i) => {
      totalRanks.set(d.pid, {
        group,
        rank: i + 1,
        outOf: totalEligible.length,
        value: round(d.total),
      });
    });

    groupCounts.set(group, { ppg: ppgEligible.length, total: totalEligible.length });
  }

  const byPlayer = new Map<string, PlayerValue>();

  for (const [group, pids] of byGroup) {
    const rows = pids.map((pid) => derived.get(pid)!);

    // Percentile every raw signal within this position group.
    const pct = (pick: (d: Derived) => number | null) => {
      const entries = rows
        .filter((d) => pick(d) !== null)
        .map((d) => ({ id: d.pid, value: pick(d) as number }));
      return percentileRanks(entries);
    };

    const pPpg = pct((d) => d.ppg);
    const pTotal = pct((d) => d.total);
    const pLast8 = pct((d) => d.last8);
    const pLast4 = pct((d) => d.last4);
    const pFloor = pct((d) => d.floor);
    const pCeil = pct((d) => d.ceiling);
    const pAvail = pct((d) => d.availability);
    const pDelta = pct((d) => d.deltaAvg);
    const pUsage = pct((d) => d.oppPerGame);
    const pEff = pct((d) => d.effAvg);
    const pTrend = pct((d) => d.oppTrend);

    const counts = groupCounts.get(group)!;

    for (const d of rows) {
      const ppgRank = ppgRanks.get(d.pid);
      const totalRank = totalRanks.get(d.pid);

      // Each entry: [label, weight, normalised 0..1 signal]
      const terms: Array<[string, number, number]> = [
        ['PPG rank', VALUE_WEIGHTS.ppgRank, rankScore(ppgRank?.rank, counts.ppg)],
        ['Total rank', VALUE_WEIGHTS.totalRank, rankScore(totalRank?.rank, counts.total)],
        ['PPG', VALUE_WEIGHTS.ppg, pPpg.get(d.pid) ?? 0.5],
        ['Total points', VALUE_WEIGHTS.total, pTotal.get(d.pid) ?? 0.5],
        ['Last 8', VALUE_WEIGHTS.last8, pLast8.get(d.pid) ?? 0.5],
        ['Momentum', VALUE_WEIGHTS.recency, d.recencyAdj],
        ['Availability', VALUE_WEIGHTS.availability, pAvail.get(d.pid) ?? 0.5],
        ['Consistency', VALUE_WEIGHTS.consistency, d.consistency],
        ['Floor', VALUE_WEIGHTS.floor, pFloor.get(d.pid) ?? 0.5],
        ['Ceiling', VALUE_WEIGHTS.ceiling, pCeil.get(d.pid) ?? 0.5],
        ['Boom/bust', VALUE_WEIGHTS.boomBust, d.boomBustAdj],
        ['Beats projection', VALUE_WEIGHTS.delta, pDelta.get(d.pid) ?? 0.5],
        ['Usage', VALUE_WEIGHTS.usage, pUsage.get(d.pid) ?? 0.5],
        ['Efficiency', VALUE_WEIGHTS.efficiency, pEff.get(d.pid) ?? 0.5],
        ['Market', VALUE_WEIGHTS.market, d.marketAdj],
        ['Usage trend', VALUE_WEIGHTS.usageTrend, pTrend.get(d.pid) ?? 0.5],
        ['Last 4', VALUE_WEIGHTS.last4, pLast4.get(d.pid) ?? 0.5],
        ['Snap share', VALUE_WEIGHTS.snaps, d.snapAdj],
      ];

      let raw = 0;
      const contributions = terms.map(([label, weight, normalized]) => {
        const points = weight * normalized;
        raw += points;
        return { label, weight, normalized, points };
      });

      // Small-sample handling: blend toward neutral instead of crushing the
      // score, so a player with 2 great games isn't ranked above a proven one
      // but also isn't buried.
      const gamesConfidence = 0.45 + 0.55 * clamp01((d.games - 1) / 5);
      raw = 0.5 + (raw - 0.5) * gamesConfidence;

      const finalScore = Math.round(clamp01(raw) * 1000);

      byPlayer.set(d.pid, {
        pid: d.pid,
        score: finalScore,
        group,
        breakdown: {
          group,
          games: d.games,
          ppg: round(d.ppg),
          total: round(d.total),
          last4: round(d.last4),
          last8: round(d.last8),
          availability: round(d.availability, 3),
          consistency: round(d.consistency, 3),
          floor: round(d.floor),
          ceiling: round(d.ceiling),
          boomRate: round(d.boomRate, 3),
          bustRate: round(d.bustRate, 3),
          deltaAvg: round(d.deltaAvg),
          deltaBeatRate: round(d.deltaBeatAdj, 3),
          usagePerGame: d.oppPerGame === null ? null : round(d.oppPerGame, 1),
          usageTrend: round(d.oppTrend, 3),
          efficiency: d.effAvg === null ? null : round(d.effAvg, 2),
          snapPct: d.snapRaw === null ? null : round(d.snapRaw, 1),
          ownedPct: d.owned,
          startedPct: d.started,
          gamesConfidence: round(gamesConfidence, 3),
          contributions,
        },
      });
    }
  }

  // Weekly detail + season totals, exposed for charts and history views.
  const weeklyScores = new Map<string, Array<{ week: number; actual: number; projected: number | null }>>();
  const seasonTotals = new Map<string, number>();
  for (const [pid, a] of agg) {
    a.weeklyDetail.sort((x, y) => x.week - y.week);
    weeklyScores.set(pid, a.weeklyDetail);
    seasonTotals.set(pid, round(a.total));
  }

  return { byPlayer, ppgRanks, totalRanks, weeklyScores, seasonTotals };
}
