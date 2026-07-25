/**
 * Dynasty Value Score (0–1000).
 *
 * A *dynasty* valuation is a different question than the in-season Value Score in
 * `value.ts`. That model deliberately excludes age and asks "who is producing
 * right now". This one asks "what should this player be worth as a long-term
 * asset", and to answer it honestly it has to weigh things the in-season model
 * ignores on purpose: value over replacement, positional scarcity, age and
 * career runway, role security, and — the piece Sleeper cannot give us — the
 * current trade market.
 *
 * Two numbers fall out of that. The intrinsic dynasty score (what the player
 * should be worth) and the market's price (FantasyCalc). The gap between them is
 * the actionable output: buy-low when intrinsic beats market, sell-high when
 * market beats intrinsic.
 *
 * Design choices worth preserving:
 *  - Production is blended across seasons: 80% the current year, 20% the prior
 *    two, so a single hot or cold season doesn't define a multi-year asset.
 *  - Production enters as VORP (points above the league's real replacement level,
 *    derived from its actual starting requirements) and is percentiled *across
 *    all positions*, so a scarce-position starter outranks a deep-position one —
 *    the whole point of a superflex, TE-premium, IDP league.
 *  - Age is a position-specific longevity curve, not a flat cutoff.
 *  - A missing market value (every IDP, since FantasyCalc doesn't price them) is
 *    read as neutral, never as zero.
 */

import { longevity, resolveAge } from './longevity';
import type { MarketEntry } from './market';
import { clamp01, percentileRanks, round } from './stats';
import type { Player, PositionGroup } from './types';
import type { ValueIndex } from './value';

/** Blend weight on the current season; the prior two share the remainder. */
export const CURRENT_SEASON_WEIGHT = 0.8;

/**
 * Dynasty leg weights (sum ~1.0), tuned for a superflex, TE-premium, IDP league.
 *
 * Every leg is percentiled *within the player's own position group*, so the
 * dynasty score is directly averageable with the in-season Value Score and both
 * read the same way: "top of his own pool", not comparable across positions.
 * (Cross-position scarcity therefore isn't a leg — within a group it would be a
 * constant and change no ordering; positional scarcity instead lives implicitly
 * in each group's own VORP-over-replacement spread.)
 *
 * Production dominates but does not swamp; age carries real weight because this
 * is a forward-looking model; market is a meaningful but minority voice so the
 * score stays an *intrinsic* opinion the market can be measured against.
 */
export const DYNASTY_WEIGHTS = {
  production: 0.4,
  age: 0.16,
  market: 0.16,
  role: 0.12,
  insulation: 0.06,
  efficiency: 0.05,
  risk: 0.05,
} as const;

/** Contender lens: reweight toward immediate, available production. */
const CONTENDER_WEIGHTS: Record<keyof typeof DYNASTY_WEIGHTS, number> = {
  production: 0.45,
  age: 0.05,
  market: 0.12,
  role: 0.16,
  insulation: 0.05,
  efficiency: 0.07,
  risk: 0.1,
};

/** Rebuilder lens: reweight toward youth, insulation and liquidity. */
const REBUILDER_WEIGHTS: Record<keyof typeof DYNASTY_WEIGHTS, number> = {
  production: 0.3,
  age: 0.28,
  market: 0.16,
  role: 0.08,
  insulation: 0.1,
  efficiency: 0.04,
  risk: 0.04,
};

export type MarketVerdict = 'Buy' | 'Sell' | 'Fair' | 'No market';
export type Trend = 'Rising' | 'Falling' | 'Stable' | 'Unknown';
export type RiskBand = 'Low' | 'Moderate' | 'High';
export type Liquidity = 'High' | 'Moderate' | 'Low';

export interface DynastyBreakdown {
  group: PositionGroup;
  age: number | null;
  games: number;
  currentPpg: number | null;
  priorPpg: number | null;
  blendedPpg: number | null;
  replacementPpg: number;
  vorp: number | null;
  contenderScore: number;
  rebuilderScore: number;
  marketValue: number | null;
  marketOverallRank: number | null;
  marketPositionRank: number | null;
  verdict: MarketVerdict;
  marketTrend: Trend;
  liquidity: Liquidity;
  injuryRisk: RiskBand;
  /** Value tier label derived from the score, e.g. "Elite dynasty asset". */
  tier: string;
  /** Per-leg contributions, for the "why this score" panel. */
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface DynastyValue {
  pid: string;
  score: number;
  group: PositionGroup;
  breakdown: DynastyBreakdown;
}

export interface DynastyIndex {
  byPlayer: Map<string, DynastyValue>;
  /** Replacement-level blended PPG per position group, for display. */
  replacementByGroup: Map<PositionGroup, number>;
}

/** Per-player blended production summary for one prior season. */
export type SeasonPpg = Map<string, { ppg: number; games: number }>;

export interface BuildDynastyIndexInput {
  valueIndex: ValueIndex;
  playersById: Map<string, Player>;
  /** Prior-season PPG maps, most-recent first. Up to two. */
  priorSeasons: SeasonPpg[];
  market: Map<string, MarketEntry>;
  rosterPositions: string[];
  numTeams: number;
  /** Games needed before a player anchors replacement level. */
  throughWeek: number;
}

/* -------------------------------------------------------------------------- */
/* Replacement level                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How each roster slot distributes onto position groups.
 *
 * Dedicated slots map one-to-one; flex slots are split by how the flex is
 * realistically filled. Superflex is treated as a quarterback slot because in a
 * superflex league that is what wins there almost every week.
 */
const FLEX_SPLIT: Record<string, Partial<Record<PositionGroup, number>>> = {
  FLEX: { RB: 0.35, WR: 0.5, TE: 0.15 },
  WRRB_FLEX: { RB: 0.45, WR: 0.55 },
  REC_FLEX: { WR: 0.7, TE: 0.3 },
  WRRB_WRT: { RB: 0.35, WR: 0.5, TE: 0.15 },
  SUPER_FLEX: { QB: 1 },
  OP: { QB: 1 },
  IDP_FLEX: { DL: 0.3, LB: 0.5, DB: 0.2 },
  DB_FLEX: { DB: 1 },
  DL_FLEX: { DL: 1 },
  LB_FLEX: { LB: 1 },
};

const SLOT_TO_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DL: 'DL',
  DE: 'DL',
  DT: 'DL',
  LB: 'LB',
  DB: 'DB',
  CB: 'DB',
  S: 'DB',
};

/**
 * Fractional starting depth per position, from the league's real lineup.
 *
 * e.g. a 6-team superflex league starting one QB plus a superflex yields a QB
 * depth of 12 — replacement is roughly the 12th-best quarterback, which is why a
 * merely-startable QB holds value the same points at RB would not.
 */
export function startingDepthByGroup(
  rosterPositions: string[],
  numTeams: number,
): Map<PositionGroup, number> {
  const perTeam = new Map<PositionGroup, number>();
  const add = (group: PositionGroup, n: number) =>
    perTeam.set(group, (perTeam.get(group) ?? 0) + n);

  for (const raw of rosterPositions) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN' || slot === 'TAXI' || slot === 'IR') continue;

    const direct = SLOT_TO_GROUP[slot];
    if (direct) {
      add(direct, 1);
      continue;
    }
    const split = FLEX_SPLIT[slot];
    if (split) {
      for (const [group, share] of Object.entries(split)) {
        add(group as PositionGroup, share ?? 0);
      }
    }
  }

  const depth = new Map<PositionGroup, number>();
  for (const [group, n] of perTeam) depth.set(group, n * numTeams);
  return depth;
}

/**
 * Replacement-level blended PPG for a group: the production of the player right
 * at the startable cliff. Averaged over a small band around the cliff so a
 * single outlier doesn't set the baseline.
 */
function replacementPpg(sortedDesc: number[], depth: number): number {
  if (!sortedDesc.length) return 0;
  const idx = Math.max(0, Math.round(depth) - 1);
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(sortedDesc.length - 1, idx + 1);
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += sortedDesc[i];
    n++;
  }
  // Past the end of the pool, replacement is effectively the worst startable.
  return n ? sum / n : sortedDesc[sortedDesc.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

const TIERS: Array<[number, string]> = [
  [950, 'Untouchable cornerstone'],
  [900, 'Elite dynasty asset'],
  [850, 'High-end foundational asset'],
  [800, 'Strong core starter'],
  [750, 'Quality starter'],
  [700, 'Useful starter or premium depth'],
  [600, 'Depth asset with meaningful value'],
  [500, 'Situational or speculative asset'],
  [0, 'Replacement-level or low-liquidity asset'],
];

function tierFor(score: number): string {
  for (const [floor, label] of TIERS) if (score >= floor) return label;
  return TIERS[TIERS.length - 1][1];
}

interface Row {
  pid: string;
  group: PositionGroup;
  age: number | null;
  games: number;
  currentPpg: number | null;
  priorPpg: number | null;
  blendedPpg: number | null;
  vorp: number | null;
  roleRaw: number | null;
  effRaw: number | null;
  availability: number;
  injuryFactor: number;
  yearsExp: number | null;
  market: MarketEntry | null;
}

/** Games-weighted prior-season PPG across the (up to two) prior seasons. */
function priorAveragePpg(priorSeasons: SeasonPpg[], pid: string): number | null {
  let weighted = 0;
  let games = 0;
  for (const season of priorSeasons) {
    const s = season.get(pid);
    if (s && s.games > 0) {
      weighted += s.ppg * s.games;
      games += s.games;
    }
  }
  return games > 0 ? weighted / games : null;
}

/**
 * Blends current and prior production per the 80/20 rule. Falls back gracefully:
 * a player with only current data keeps it, one with only prior data (didn't
 * play this year) is carried at his prior form.
 */
function blendPpg(current: number | null, prior: number | null): number | null {
  if (current !== null && prior !== null) {
    return CURRENT_SEASON_WEIGHT * current + (1 - CURRENT_SEASON_WEIGHT) * prior;
  }
  return current ?? prior;
}

/** Maps a current injury designation to a 0..1 availability multiplier. */
function injuryFactorFor(player: Player | undefined): number {
  const status = String(player?.injury_status ?? player?.status ?? '')
    .trim()
    .toUpperCase();
  if (!status || status === 'ACTIVE') return 1;
  if (status === 'QUESTIONABLE') return 0.92;
  if (status === 'DOUBTFUL') return 0.8;
  if (status === 'IR' || status === 'PUP' || status === 'NFI') return 0.55;
  if (status === 'OUT' || status === 'SUSP' || status === 'SUSPENDED') return 0.65;
  return 0.85;
}

export function buildDynastyIndex(input: BuildDynastyIndexInput): DynastyIndex {
  const { valueIndex, playersById, priorSeasons, market, rosterPositions, numTeams } = input;

  const depth = startingDepthByGroup(rosterPositions, numTeams);

  // The universe: everyone with current-season production, plus market-priced
  // players who haven't recorded a snap (stashed rookies, returning veterans).
  const pids = new Set<string>(valueIndex.byPlayer.keys());
  for (const pid of market.keys()) if (playersById.has(pid)) pids.add(pid);

  const rows: Row[] = [];
  const byGroup = new Map<PositionGroup, Row[]>();

  for (const pid of pids) {
    const v = valueIndex.byPlayer.get(pid);
    const player = playersById.get(pid);
    const group = v?.group ?? groupOf(player);
    if (!group) continue;

    const b = v?.breakdown;
    const games = b?.games ?? 0;
    const currentPpg = b ? b.ppg : null;
    const priorPpg = priorAveragePpg(priorSeasons, pid);
    const blendedPpg = blendPpg(currentPpg, priorPpg);

    // Role: recent opportunity share leads, snap share supports.
    const share = b?.recentOpportunityShare ?? b?.opportunityShare ?? null;
    const snap = b?.recentSnapPct ?? b?.snapPct ?? null;
    let roleRaw: number | null = null;
    if (share !== null || snap !== null) {
      const parts: number[] = [];
      if (share !== null) parts.push(clamp01(share) * 0.6);
      if (snap !== null) parts.push(clamp01(snap / 100) * 0.4);
      const denom = (share !== null ? 0.6 : 0) + (snap !== null ? 0.4 : 0);
      roleRaw = denom ? parts.reduce((x, y) => x + y, 0) / denom : null;
    }

    const row: Row = {
      pid,
      group,
      age: resolveAge(player),
      games,
      currentPpg,
      priorPpg,
      blendedPpg,
      vorp: null,
      roleRaw,
      effRaw: b?.efficiency ?? null,
      availability: b ? b.availability : 0.6,
      injuryFactor: injuryFactorFor(player),
      yearsExp: typeof player?.years_exp === 'number' ? player.years_exp : null,
      market: market.get(pid) ?? null,
    };
    rows.push(row);
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(row);
    else byGroup.set(group, [row]);
  }

  // Replacement level per group, from qualified producers only, then VORP.
  const replacementByGroup = new Map<PositionGroup, number>();
  const minGames = Math.max(2, Math.floor(input.throughWeek * 0.3));
  for (const [group, groupRows] of byGroup) {
    const producers = groupRows
      .filter((r) => r.blendedPpg !== null && (r.games >= minGames || r.priorPpg !== null))
      .map((r) => r.blendedPpg as number)
      .sort((a, b) => b - a);
    const repl = replacementPpg(producers, depth.get(group) ?? producers.length);
    replacementByGroup.set(group, repl);
    for (const r of groupRows) {
      if (r.blendedPpg !== null) r.vorp = r.blendedPpg - repl;
    }
  }

  // Every leg is percentiled *within its own position group*, so the dynasty
  // score is on the same footing as the in-season Value Score and the two can be
  // averaged into a single number. VORP is percentiled in-group rather than
  // globally: "how far above a startable player at your position" is what a
  // dynasty owner is actually paying for, and positional scarcity is already
  // baked into each group's own replacement level.
  const vorpByGroup = new Map<PositionGroup, Map<string, number>>();
  const marketByGroup = new Map<PositionGroup, Map<string, number>>();
  const roleByGroup = new Map<PositionGroup, Map<string, number>>();
  const effByGroup = new Map<PositionGroup, Map<string, number>>();
  const inGroup = (
    groupRows: Row[],
    pick: (r: Row) => number | null,
  ): Map<string, number> =>
    percentileRanks(
      groupRows
        .filter((r) => pick(r) !== null)
        .map((r) => ({ id: r.pid, value: pick(r) as number })),
    );
  for (const [group, groupRows] of byGroup) {
    vorpByGroup.set(group, inGroup(groupRows, (r) => r.vorp));
    marketByGroup.set(group, inGroup(groupRows, (r) => r.market?.value ?? null));
    roleByGroup.set(group, inGroup(groupRows, (r) => r.roleRaw));
    effByGroup.set(group, inGroup(groupRows, (r) => r.effRaw));
  }

  const byPlayer = new Map<string, DynastyValue>();

  for (const r of rows) {
    const market = r.market;
    const marketNorm = market ? (marketByGroup.get(r.group)?.get(r.pid) ?? 0.5) : 0.5;
    // Production: VORP percentile within the position when we have it; otherwise
    // lean on the market for players with no snaps yet, and only then fall back
    // to a low prior.
    const prodNorm =
      r.vorp !== null
        ? (vorpByGroup.get(r.group)?.get(r.pid) ?? 0.4)
        : market
          ? marketNorm
          : 0.3;
    const ageNorm = longevity(r.group, r.age);
    const roleNorm = r.roleRaw !== null ? (roleByGroup.get(r.group)?.get(r.pid) ?? 0.5) : 0.5;
    const effNorm = r.effRaw !== null ? (effByGroup.get(r.group)?.get(r.pid) ?? 0.5) : 0.5;
    const riskNorm = clamp01(
      (r.games > 0 ? r.availability : 0.6) * r.injuryFactor,
    );

    // Insulation: how well value survives a rough patch — youth, a real role,
    // market standing, and early-career draft runway.
    const youthExp =
      r.yearsExp === null ? 0.5 : clamp01(1 - r.yearsExp / 10);
    const insulationNorm = clamp01(
      0.35 * ageNorm + 0.3 * marketNorm + 0.2 * roleNorm + 0.15 * youthExp,
    );

    const legs: Record<keyof typeof DYNASTY_WEIGHTS, number> = {
      production: prodNorm,
      age: ageNorm,
      market: marketNorm,
      role: roleNorm,
      insulation: insulationNorm,
      efficiency: effNorm,
      risk: riskNorm,
    };

    const rawFor = (weights: Record<keyof typeof DYNASTY_WEIGHTS, number>) => {
      let sum = 0;
      for (const key of Object.keys(weights) as Array<keyof typeof DYNASTY_WEIGHTS>) {
        sum += weights[key] * legs[key];
      }
      return sum;
    };

    let raw = rawFor(DYNASTY_WEIGHTS);

    // Small-sample handling mirrors the in-season model: blend toward neutral
    // for players with little to go on. A market-priced player without snaps
    // still carries real information, so he is shrunk only lightly.
    const confidence =
      r.games > 0 ? 0.7 + 0.3 * clamp01((r.games - 1) / 4) : market ? 0.8 : 0.55;
    raw = 0.5 + (raw - 0.5) * confidence;

    const score = Math.round(clamp01(raw) * 1000);
    const contenderScore = Math.round(clamp01(rawFor(CONTENDER_WEIGHTS)) * 1000);
    const rebuilderScore = Math.round(clamp01(rawFor(REBUILDER_WEIGHTS)) * 1000);

    const contributions = (Object.keys(DYNASTY_WEIGHTS) as Array<keyof typeof DYNASTY_WEIGHTS>).map(
      (key) => ({
        label: LEG_LABELS[key],
        weight: DYNASTY_WEIGHTS[key],
        normalized: legs[key],
        points: DYNASTY_WEIGHTS[key] * legs[key],
      }),
    );

    byPlayer.set(r.pid, {
      pid: r.pid,
      score,
      group: r.group,
      breakdown: {
        group: r.group,
        age: r.age,
        games: r.games,
        currentPpg: r.currentPpg === null ? null : round(r.currentPpg, 1),
        priorPpg: r.priorPpg === null ? null : round(r.priorPpg, 1),
        blendedPpg: r.blendedPpg === null ? null : round(r.blendedPpg, 1),
        replacementPpg: round(replacementByGroup.get(r.group) ?? 0, 1),
        vorp: r.vorp === null ? null : round(r.vorp, 1),
        contenderScore,
        rebuilderScore,
        marketValue: market ? market.value : null,
        marketOverallRank: market ? market.overallRank : null,
        marketPositionRank: market ? market.positionRank : null,
        verdict: verdictFor(market, raw, marketNorm),
        marketTrend: trendFor(market),
        liquidity: liquidityFor(market, marketNorm),
        injuryRisk: riskBandFor(riskNorm),
        tier: tierFor(score),
        contributions,
      },
    });
  }

  return { byPlayer, replacementByGroup };
}

/* -------------------------------------------------------------------------- */
/* Leg helpers                                                                 */
/* -------------------------------------------------------------------------- */

const LEG_LABELS: Record<keyof typeof DYNASTY_WEIGHTS, string> = {
  production: 'Multi-year VORP',
  age: 'Age & longevity',
  market: 'Market value',
  role: 'Role & usage',
  insulation: 'Value insulation',
  efficiency: 'Talent & efficiency',
  risk: 'Availability & injury',
};

function groupOf(player: Player | undefined): PositionGroup | null {
  if (!player) return null;
  const candidates = [
    player.position,
    ...(player.fantasy_positions ?? []),
    player.depth_chart_position,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const group = SLOT_TO_GROUP[String(raw).trim().toUpperCase()];
    if (group) return group;
  }
  return null;
}

function verdictFor(
  market: MarketEntry | null,
  raw: number,
  marketNorm: number,
): MarketVerdict {
  if (!market) return 'No market';
  // Compare the intrinsic opinion (this score) against where the market prices
  // the player within his position. A wide, consistent gap is a buy or sell
  // signal.
  const gap = raw - marketNorm;
  if (gap > 0.12) return 'Buy';
  if (gap < -0.12) return 'Sell';
  return 'Fair';
}

function trendFor(market: MarketEntry | null): Trend {
  if (!market) return 'Unknown';
  const deadband = Math.max(20, market.value * 0.02);
  if (market.trend30Day > deadband) return 'Rising';
  if (market.trend30Day < -deadband) return 'Falling';
  return 'Stable';
}

function liquidityFor(market: MarketEntry | null, marketNorm: number): Liquidity {
  if (!market) return 'Low';
  if (marketNorm > 0.85) return 'High';
  if (marketNorm > 0.5) return 'Moderate';
  return 'Low';
}

function riskBandFor(riskNorm: number): RiskBand {
  if (riskNorm >= 0.8) return 'Low';
  if (riskNorm >= 0.55) return 'Moderate';
  return 'High';
}
