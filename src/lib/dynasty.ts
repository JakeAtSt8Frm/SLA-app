/**
 * Market-independent, league-specific dynasty valuation.
 *
 * The headline score answers "how much future lineup value should this player
 * create in this league?" FantasyCalc is deliberately kept outside that answer:
 * it is normalized separately, then compared with intrinsic value for the
 * buy/sell verdict and optionally blended into a consensus score.
 *
 * Production is cardinal rather than rank-only. A game-weighted Bayesian talent
 * estimate feeds discounted future points above two league-specific baselines:
 *
 *  - the marginal starter from an exact league-wide lineup assignment; and
 *  - the best currently unrostered player at the position.
 *
 * That preserves the size of elite advantages and lets superflex, flex, TE
 * premium, deep IDP lineups and a shallow player pool affect value directly.
 */

import { longevity, resolveAge } from './longevity';
import type { MarketEntry } from './market';
import { computeOptimalLineup, slotAccepts, starterSlots } from './optimal';
import { groupForPlayer } from './scoring';
import { clamp01, percentileRanks, quantile, round } from './stats';
import type { Player, PositionGroup } from './types';
import type { ValueIndex } from './value';

/** Per-game recency weights, newest season first. */
export const SEASON_GAME_WEIGHTS = [1, 0.55, 0.3] as const;
/** Equivalent games in the position/role/draft-capital prior. */
export const TALENT_PRIOR_GAMES = 8;
const FUTURE_DISCOUNTS = [1, 0.8, 0.64] as const;
const EXPECTED_SEASON_GAMES = 17;
const STARTER_VALUE_SHARE = 0.7;
const WAIVER_VALUE_SHARE = 1 - STARTER_VALUE_SHARE;

/**
 * Intrinsic legs. Market is intentionally absent, and age is integrated into
 * each future-season projection rather than awarded again as a flat bonus.
 */
export const DYNASTY_WEIGHTS = {
  production: 0.68,
  role: 0.14,
  insulation: 0.08,
  efficiency: 0.05,
  availability: 0.05,
} as const;

type DynastyLeg = keyof typeof DYNASTY_WEIGHTS;
type DynastyWeights = Record<DynastyLeg, number>;

/** Win-now lens: immediate lineup gain and current availability matter more. */
const CONTENDER_WEIGHTS: DynastyWeights = {
  production: 0.72,
  role: 0.15,
  insulation: 0.03,
  efficiency: 0.04,
  availability: 0.06,
};

/** Rebuilder lens: discounted future gain plus market-free role insulation. */
const REBUILDER_WEIGHTS: DynastyWeights = {
  production: 0.62,
  role: 0.12,
  insulation: 0.18,
  efficiency: 0.03,
  availability: 0.05,
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
  /** Bayesian, game-weighted estimate of current scoring talent. */
  projectedPpg: number;
  /** Exact league-wide marginal starter baseline. */
  replacementPpg: number;
  /** Best currently unrostered player at the position. */
  waiverReplacementPpg: number;
  /** Current projected PPG over the starter baseline. */
  vorp: number;
  /** Three-year discounted lineup points above both replacement concepts. */
  futureVorp: number;
  contenderScore: number;
  rebuilderScore: number;
  consensusScore: number;
  marketScore: number | null;
  valueGap: number | null;
  marketValue: number | null;
  marketOverallRank: number | null;
  marketPositionRank: number | null;
  verdict: MarketVerdict;
  marketTrend: Trend;
  liquidity: Liquidity;
  injuryRisk: RiskBand;
  /** Evidence strength behind the production estimate, 0..1. */
  productionConfidence: number;
  /** Value tier label derived from intrinsic score. */
  tier: string;
  /** Per-leg contributions, for the "why this score" panel. */
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface DynastyValue {
  pid: string;
  /** Market-independent intrinsic dynasty value, 0..1000. */
  score: number;
  group: PositionGroup;
  breakdown: DynastyBreakdown;
}

export interface DynastyIndex {
  byPlayer: Map<string, DynastyValue>;
  /** Exact marginal-starter PPG by position group. */
  replacementByGroup: Map<PositionGroup, number>;
  /** Best unrostered PPG by position group. */
  waiverReplacementByGroup: Map<PositionGroup, number>;
}

/** Per-player production summary for one prior season. */
export type SeasonPpg = Map<string, { ppg: number; games: number }>;

export interface BuildDynastyIndexInput {
  valueIndex: ValueIndex;
  playersById: Map<string, Player>;
  /** Prior-season PPG maps, most-recent first. Up to two. */
  priorSeasons: SeasonPpg[];
  market: Map<string, MarketEntry>;
  rosterPositions: string[];
  numTeams: number;
  /** Players on active rosters, taxi squads or reserve. */
  rosteredPlayerIds?: ReadonlySet<string>;
  throughWeek: number;
}

interface Row {
  pid: string;
  group: PositionGroup;
  player: Player | undefined;
  age: number | null;
  games: number;
  currentPpg: number | null;
  priorPpg: number | null;
  observedPpg: number | null;
  effectiveGames: number;
  projectedPpg: number;
  roleRaw: number;
  effRaw: number | null;
  availability: number;
  injuryFactor: number;
  yearsExp: number | null;
  market: MarketEntry | null;
  draftCapital: number;
  futureVorp: number;
  immediateVorp: number;
  productionConfidence: number;
}

const TIERS: Array<[number, string]> = [
  [950, 'Untouchable cornerstone'],
  [900, 'Elite dynasty asset'],
  [850, 'High-end foundational asset'],
  [800, 'Strong core starter'],
  [700, 'Quality starter'],
  [550, 'Useful starter or premium depth'],
  [350, 'Depth asset with meaningful value'],
  [150, 'Situational or speculative asset'],
  [0, 'Replacement-level or low-liquidity asset'],
];

function tierFor(score: number): string {
  for (const [floor, label] of TIERS) if (score >= floor) return label;
  return TIERS[TIERS.length - 1][1];
}

/**
 * Weighted production across individual season game samples.
 *
 * Unlike a fixed 80/20 season blend, one hot current-season game contributes
 * one game of evidence rather than overwhelming dozens of prior games.
 */
function weightedProduction(
  currentPpg: number | null,
  currentGames: number,
  priorSeasons: SeasonPpg[],
  pid: string,
): { ppg: number | null; effectiveGames: number; priorPpg: number | null } {
  let weightedPoints = 0;
  let effectiveGames = 0;
  let priorPoints = 0;
  let priorGames = 0;

  if (currentPpg !== null && currentGames > 0) {
    weightedPoints += currentPpg * currentGames * SEASON_GAME_WEIGHTS[0];
    effectiveGames += currentGames * SEASON_GAME_WEIGHTS[0];
  }

  for (let index = 0; index < priorSeasons.length && index < 2; index++) {
    const season = priorSeasons[index].get(pid);
    if (!season || season.games <= 0) continue;
    const weight = SEASON_GAME_WEIGHTS[index + 1];
    weightedPoints += season.ppg * season.games * weight;
    effectiveGames += season.games * weight;
    priorPoints += season.ppg * season.games;
    priorGames += season.games;
  }

  return {
    ppg: effectiveGames > 0 ? weightedPoints / effectiveGames : null,
    effectiveGames,
    priorPpg: priorGames > 0 ? priorPoints / priorGames : null,
  };
}

/** Objective NFL draft-capital strength, independent of market price. */
function draftCapitalFor(market: MarketEntry | null): number {
  if (!market) return 0.35;
  if (market.draftPick !== null && market.draftPick > 0) {
    return clamp01(1 - (market.draftPick - 1) / 220);
  }
  if (market.draftRound !== null && market.draftRound > 0) {
    return clamp01(1 - (market.draftRound - 1) / 7);
  }
  return 0.35;
}

/** Depth-chart/job prior used when production has not established the role. */
function depthChartRoleFor(player: Player | undefined): number {
  if (!player || player.active === false) return 0.2;
  const order = player.depth_chart_order;
  if (typeof order === 'number' && order > 0) {
    if (order === 1) return 0.95;
    if (order === 2) return 0.72;
    if (order === 3) return 0.5;
    return 0.32;
  }
  return player.team ? 0.45 : 0.25;
}

/**
 * Independent prior for a player with limited NFL evidence.
 *
 * Rookies use objective draft capital, age-position runway and depth-chart
 * standing. No FantasyCalc value, rank, ADP or trade frequency enters here.
 */
function priorTalentPpg(row: Row, positionBaseline: number): number {
  const depthRole = depthChartRoleFor(row.player);
  const isRookie = row.yearsExp === 0;
  if (!isRookie) return positionBaseline * (0.65 + 0.35 * depthRole);

  const prospectStrength =
    0.55 * row.draftCapital +
    0.25 * depthRole +
    0.2 * longevity(row.group, row.age);
  return positionBaseline * (0.55 + 0.75 * prospectStrength);
}

/**
 * Position-aware role signal. Box-score "opportunities" are outcomes for IDPs,
 * so defensive snap share receives most of the weight when it is available.
 */
function roleFor(
  group: PositionGroup,
  share: number | null,
  snaps: number | null,
  fallback: number,
): number {
  const snap = snaps === null ? null : clamp01(snaps / 100);
  const opportunity = share === null ? null : clamp01(share);
  const weights =
    group === 'DL' || group === 'LB' || group === 'DB'
      ? { opportunity: 0.2, snap: 0.8 }
      : group === 'QB'
        ? { opportunity: 0.25, snap: 0.75 }
        : { opportunity: 0.6, snap: 0.4 };

  const numerator =
    (opportunity === null ? 0 : opportunity * weights.opportunity) +
    (snap === null ? 0 : snap * weights.snap);
  const denominator =
    (opportunity === null ? 0 : weights.opportunity) +
    (snap === null ? 0 : weights.snap);
  return denominator > 0 ? numerator / denominator : fallback;
}

function currentAvailability(games: number, throughWeek: number): number {
  const observedWeeks = Math.max(games, Math.min(EXPECTED_SEASON_GAMES, throughWeek));
  // Eight and a half available games in a ten-game prior prevents early-season
  // absences and bye timing from dominating a three-year valuation.
  return clamp01((games + 8.5) / (observedWeeks + 10));
}

/** Current injury designation only affects the contender lens. */
function injuryFactorFor(player: Player | undefined): number {
  const status = String(player?.injury_status ?? player?.status ?? '')
    .trim()
    .toUpperCase();
  if (!status || status === 'ACTIVE') return 1;
  if (status === 'QUESTIONABLE') return 0.92;
  if (status === 'DOUBTFUL') return 0.78;
  if (status === 'IR' || status === 'PUP' || status === 'NFI') return 0.5;
  if (status === 'OUT' || status === 'SUSP' || status === 'SUSPENDED') return 0.65;
  return 0.85;
}

function allLeagueStarterSlots(rosterPositions: string[], numTeams: number): string[] {
  const perTeam = starterSlots(rosterPositions);
  return Array.from({ length: Math.max(1, numTeams) }, () => perTeam).flat();
}

/**
 * Keeps only candidates capable of affecting the exact assignment.
 *
 * A position cannot fill more slots than accept that position, so players below
 * that count plus a two-player replacement buffer cannot change the result.
 */
function assignmentCandidates(rows: Row[], slots: string[]) {
  const byGroup = new Map<PositionGroup, Row[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.projectedPpg)) continue;
    const bucket = byGroup.get(row.group);
    if (bucket) bucket.push(row);
    else byGroup.set(row.group, [row]);
  }

  return [...byGroup.entries()].flatMap(([group, groupRows]) => {
    const eligibleSlots = slots.filter((slot) => slotAccepts(slot, group)).length;
    return groupRows
      .sort((a, b) => b.projectedPpg - a.projectedPpg)
      .slice(0, eligibleSlots + 2)
      .map((row) => ({ pid: row.pid, group, points: row.projectedPpg }));
  });
}

/**
 * Exact marginal-starter threshold by group.
 *
 * For each position we remove the lowest selected player in that group and
 * resolve the assignment. The lost total is that player's true marginal lineup
 * gain, including any cross-position flex reshuffle; subtracting it from his PPG
 * yields the effective replacement threshold for every player in the group.
 */
function exactStarterReplacement(
  rows: Row[],
  rosterPositions: string[],
  numTeams: number,
): Map<PositionGroup, number> {
  const slots = allLeagueStarterSlots(rosterPositions, numTeams);
  const replacement = new Map<PositionGroup, number>();
  if (!slots.length) return replacement;

  const candidates = assignmentCandidates(rows, slots);
  const baseline = computeOptimalLineup(slots, candidates);
  const candidatesByPid = new Map(candidates.map((candidate) => [candidate.pid, candidate]));
  const selectedByGroup = new Map<PositionGroup, typeof candidates>();

  for (const assignment of baseline.assignments) {
    if (!assignment.pid) continue;
    const candidate = candidatesByPid.get(assignment.pid);
    if (!candidate || candidate.group === null) continue;
    const bucket = selectedByGroup.get(candidate.group);
    if (bucket) bucket.push(candidate);
    else selectedByGroup.set(candidate.group, [candidate]);
  }

  for (const [group, selected] of selectedByGroup) {
    const marginalStarter = selected.reduce((lowest, row) =>
      row.points < lowest.points ? row : lowest,
    );
    const without = computeOptimalLineup(
      slots,
      candidates.filter((candidate) => candidate.pid !== marginalStarter.pid),
    );
    const marginalGain = Math.max(0, baseline.total - without.total);
    replacement.set(group, Math.max(0, marginalStarter.points - marginalGain));
  }

  return replacement;
}

function fallbackBaseline(rows: Row[], group: PositionGroup): number {
  const values = rows
    .filter((row) => row.group === group && row.observedPpg !== null)
    .map((row) => row.observedPpg as number);
  return values.length ? quantile(values, 0.55) : 0;
}

function waiverReplacement(
  rows: Row[],
  rosteredPlayerIds: ReadonlySet<string> | undefined,
  starterReplacement: Map<PositionGroup, number>,
): Map<PositionGroup, number> {
  const replacement = new Map<PositionGroup, number>();
  if (!rosteredPlayerIds) return new Map(starterReplacement);

  for (const row of rows) {
    if (rosteredPlayerIds.has(row.pid)) continue;
    replacement.set(
      row.group,
      Math.max(replacement.get(row.group) ?? 0, row.projectedPpg),
    );
  }

  for (const [group, starter] of starterReplacement) {
    if (!replacement.has(group)) replacement.set(group, starter);
  }
  return replacement;
}

function magnitudeScore(value: number, scale: number): number {
  if (scale <= 0) return 0;
  // A mildly convex transform preserves cardinal differences and gives elite
  // lineup advantages the premium they merit in a shallow league.
  return Math.pow(clamp01(value / scale), 1.1);
}

function scoringScale(values: number[]): number {
  const positive = values.filter((value) => value > 0 && Number.isFinite(value));
  return positive.length ? Math.max(1, quantile(positive, 0.98)) : 1;
}

function rawFor(weights: DynastyWeights, legs: Record<DynastyLeg, number>): number {
  let total = 0;
  for (const key of Object.keys(weights) as DynastyLeg[]) total += weights[key] * legs[key];
  return clamp01(total);
}

export function buildDynastyIndex(input: BuildDynastyIndexInput): DynastyIndex {
  const { valueIndex, playersById, priorSeasons, market, rosterPositions, numTeams } = input;

  // Current producers plus market-covered rookies/stashes form the useful pool.
  const pids = new Set<string>(valueIndex.byPlayer.keys());
  for (const pid of market.keys()) if (playersById.has(pid)) pids.add(pid);

  const rows: Row[] = [];
  for (const pid of pids) {
    const value = valueIndex.byPlayer.get(pid);
    const player = playersById.get(pid);
    const group = value?.group ?? groupForPlayer(player);
    if (!group) continue;

    const breakdown = value?.breakdown;
    const games = breakdown?.games ?? 0;
    const currentPpg = breakdown?.ppg ?? null;
    const production = weightedProduction(currentPpg, games, priorSeasons, pid);
    const marketEntry = market.get(pid) ?? null;
    const depthRole = depthChartRoleFor(player);
    const share =
      breakdown?.recentOpportunityShare ?? breakdown?.opportunityShare ?? null;
    const snaps = breakdown?.recentSnapPct ?? breakdown?.snapPct ?? null;

    rows.push({
      pid,
      group,
      player,
      age: resolveAge(player),
      games,
      currentPpg,
      priorPpg: production.priorPpg,
      observedPpg: production.ppg,
      effectiveGames: production.effectiveGames,
      // Seed the first exact assignment with observed production.
      projectedPpg: production.ppg ?? 0,
      roleRaw: roleFor(group, share, snaps, depthRole),
      effRaw: breakdown?.efficiency ?? null,
      availability: currentAvailability(games, input.throughWeek),
      injuryFactor: injuryFactorFor(player),
      yearsExp: typeof player?.years_exp === 'number' ? player.years_exp : null,
      market: marketEntry,
      draftCapital: draftCapitalFor(marketEntry),
      futureVorp: 0,
      immediateVorp: 0,
      productionConfidence: clamp01(
        production.effectiveGames / (production.effectiveGames + TALENT_PRIOR_GAMES),
      ),
    });
  }

  // The first pass supplies a league-shaped prior baseline; after Bayesian
  // stabilization, the assignment is rerun on the final talent estimates.
  const initialReplacement = exactStarterReplacement(rows, rosterPositions, numTeams);
  for (const row of rows) {
    const baseline =
      initialReplacement.get(row.group) ?? fallbackBaseline(rows, row.group);
    const prior = priorTalentPpg(row, baseline);
    row.projectedPpg =
      row.observedPpg === null
        ? prior
        : (row.observedPpg * row.effectiveGames + prior * TALENT_PRIOR_GAMES) /
          (row.effectiveGames + TALENT_PRIOR_GAMES);
  }

  const replacementByGroup = exactStarterReplacement(rows, rosterPositions, numTeams);
  for (const row of rows) {
    if (!replacementByGroup.has(row.group)) {
      replacementByGroup.set(row.group, fallbackBaseline(rows, row.group));
    }
  }
  const waiverReplacementByGroup = waiverReplacement(
    rows,
    input.rosteredPlayerIds,
    replacementByGroup,
  );

  const byGroup = new Map<PositionGroup, Row[]>();
  for (const row of rows) {
    const bucket = byGroup.get(row.group);
    if (bucket) bucket.push(row);
    else byGroup.set(row.group, [row]);
  }

  const roleByGroup = new Map<PositionGroup, Map<string, number>>();
  const efficiencyByGroup = new Map<PositionGroup, Map<string, number>>();
  for (const [group, groupRows] of byGroup) {
    roleByGroup.set(
      group,
      percentileRanks(groupRows.map((row) => ({ id: row.pid, value: row.roleRaw }))),
    );
    efficiencyByGroup.set(
      group,
      percentileRanks(
        groupRows
          .filter((row) => row.effRaw !== null)
          .map((row) => ({ id: row.pid, value: row.effRaw as number })),
      ),
    );
  }

  const rowSignals = new Map<
    string,
    {
      role: number;
      efficiency: number;
      insulation: number;
      futureVorp: number;
      immediateVorp: number;
    }
  >();

  for (const row of rows) {
    const starterReplacement = replacementByGroup.get(row.group) ?? 0;
    const waiver = waiverReplacementByGroup.get(row.group) ?? starterReplacement;
    const role = roleByGroup.get(row.group)?.get(row.pid) ?? 0.5;
    const efficiency =
      row.effRaw === null
        ? 0.5
        : (efficiencyByGroup.get(row.group)?.get(row.pid) ?? 0.5);
    const youthExperience =
      row.yearsExp === null ? 0.5 : clamp01(1 - row.yearsExp / 10);
    const insulation = clamp01(
      0.45 * longevity(row.group, row.age) +
        0.3 * role +
        0.15 * youthExperience +
        0.1 * row.draftCapital,
    );

    row.immediateVorp =
      STARTER_VALUE_SHARE * Math.max(0, row.projectedPpg - starterReplacement) +
      WAIVER_VALUE_SHARE * Math.max(0, row.projectedPpg - waiver);

    const currentLongevity = longevity(row.group, row.age);
    const expectedGames = EXPECTED_SEASON_GAMES * (0.8 + 0.2 * row.availability);
    let futureVorp = 0;
    for (let year = 0; year < FUTURE_DISCOUNTS.length; year++) {
      const ageFactor =
        row.age === null || currentLongevity <= 0
          ? 1
          : clamp01(longevity(row.group, row.age + year) / currentLongevity);
      const roleProbability =
        (0.78 + 0.22 * role) * Math.pow(0.82 + 0.16 * insulation, year);
      const futurePpg = row.projectedPpg * ageFactor;
      const marginalPpg =
        STARTER_VALUE_SHARE * Math.max(0, futurePpg - starterReplacement) +
        WAIVER_VALUE_SHARE * Math.max(0, futurePpg - waiver);
      futureVorp +=
        FUTURE_DISCOUNTS[year] * expectedGames * roleProbability * marginalPpg;
    }
    row.futureVorp = futureVorp;
    rowSignals.set(row.pid, {
      role,
      efficiency,
      insulation,
      futureVorp,
      immediateVorp: row.immediateVorp,
    });
  }

  const futureScale = scoringScale(rows.map((row) => row.futureVorp));
  const immediateScale = scoringScale(rows.map((row) => row.immediateVorp));
  const marketScale = scoringScale(
    rows.flatMap((row) => (row.market ? [row.market.value] : [])),
  );

  const intrinsicByPlayer = new Map<string, number>();
  for (const row of rows) {
    const signals = rowSignals.get(row.pid);
    if (!signals) continue;
    intrinsicByPlayer.set(
      row.pid,
      rawFor(DYNASTY_WEIGHTS, {
        production: magnitudeScore(signals.futureVorp, futureScale),
        role: signals.role,
        insulation: signals.insulation,
        efficiency: signals.efficiency,
        availability: row.availability,
      }),
    );
  }
  /*
   * FantasyCalc has no IDP market. Convert its offensive-only units onto the
   * intrinsic scale of the same covered cohort; otherwise an IDP-heavy scoring
   * system would mechanically label nearly every offensive star a "Sell" merely
   * because the two 0..1000 axes had different ceilings.
   */
  const marketComparableIntrinsic = rows
    .filter((row) => row.market !== null)
    .flatMap((row) => {
      const intrinsic = intrinsicByPlayer.get(row.pid);
      return intrinsic === undefined ? [] : [intrinsic];
    });
  const marketComparableCeiling = marketComparableIntrinsic.length
    ? quantile(marketComparableIntrinsic, 0.98)
    : 1;

  const byPlayer = new Map<string, DynastyValue>();
  for (const row of rows) {
    const signals = rowSignals.get(row.pid);
    if (!signals) continue;

    const production = magnitudeScore(signals.futureVorp, futureScale);
    const legs: Record<DynastyLeg, number> = {
      production,
      role: signals.role,
      insulation: signals.insulation,
      efficiency: signals.efficiency,
      availability: row.availability,
    };
    const intrinsic = intrinsicByPlayer.get(row.pid) ?? rawFor(DYNASTY_WEIGHTS, legs);
    const score = Math.round(intrinsic * 1000);

    const contenderLegs: Record<DynastyLeg, number> = {
      ...legs,
      production: magnitudeScore(signals.immediateVorp, immediateScale),
      availability: clamp01(row.availability * row.injuryFactor),
    };
    const contenderScore = Math.round(rawFor(CONTENDER_WEIGHTS, contenderLegs) * 1000);
    const rebuilderScore = Math.round(rawFor(REBUILDER_WEIGHTS, legs) * 1000);

    const marketScore = row.market
      ? Math.round(
          magnitudeScore(row.market.value, marketScale) *
            marketComparableCeiling *
            1000,
        )
      : null;
    const consensusScore =
      marketScore === null ? score : Math.round(0.75 * score + 0.25 * marketScore);
    const valueGap = marketScore === null ? null : score - marketScore;
    // Recommendations require a wider disagreement when the talent projection
    // rests mostly on a prior (especially rookies) and tighten only as real game
    // evidence accumulates.
    const uncertainty = Math.round(90 + 260 * (1 - row.productionConfidence));
    const starterReplacement = replacementByGroup.get(row.group) ?? 0;
    const waiver = waiverReplacementByGroup.get(row.group) ?? starterReplacement;

    const contributions = (Object.keys(DYNASTY_WEIGHTS) as DynastyLeg[]).map((key) => ({
      label: LEG_LABELS[key],
      weight: DYNASTY_WEIGHTS[key],
      normalized: legs[key],
      points: DYNASTY_WEIGHTS[key] * legs[key],
    }));

    byPlayer.set(row.pid, {
      pid: row.pid,
      score,
      group: row.group,
      breakdown: {
        group: row.group,
        age: row.age,
        games: row.games,
        currentPpg: row.currentPpg === null ? null : round(row.currentPpg, 1),
        priorPpg: row.priorPpg === null ? null : round(row.priorPpg, 1),
        projectedPpg: round(row.projectedPpg, 1),
        replacementPpg: round(starterReplacement, 1),
        waiverReplacementPpg: round(waiver, 1),
        vorp: round(row.projectedPpg - starterReplacement, 1),
        futureVorp: round(row.futureVorp, 1),
        contenderScore,
        rebuilderScore,
        consensusScore,
        marketScore,
        valueGap,
        marketValue: row.market?.value ?? null,
        marketOverallRank: row.market?.overallRank ?? null,
        marketPositionRank: row.market?.positionRank ?? null,
        verdict: verdictFor(row.market, valueGap, uncertainty),
        marketTrend: trendFor(row.market),
        liquidity: liquidityFor(row.market, marketScore),
        injuryRisk: riskBandFor(row.availability),
        productionConfidence: round(row.productionConfidence, 3),
        tier: tierFor(score),
        contributions,
      },
    });
  }

  return { byPlayer, replacementByGroup, waiverReplacementByGroup };
}

const LEG_LABELS: Record<DynastyLeg, string> = {
  production: 'Future lineup value',
  role: 'Role & usage',
  insulation: 'Role insulation',
  efficiency: 'Talent & efficiency',
  availability: 'Expected availability',
};

function verdictFor(
  market: MarketEntry | null,
  valueGap: number | null,
  uncertainty: number,
): MarketVerdict {
  if (!market || valueGap === null) return 'No market';
  if (valueGap > uncertainty) return 'Buy';
  if (valueGap < -uncertainty) return 'Sell';
  return 'Fair';
}

function trendFor(market: MarketEntry | null): Trend {
  if (!market) return 'Unknown';
  const deadband = Math.max(20, market.value * 0.02);
  if (market.trend30Day > deadband) return 'Rising';
  if (market.trend30Day < -deadband) return 'Falling';
  return 'Stable';
}

function liquidityFor(market: MarketEntry | null, marketScore: number | null): Liquidity {
  if (!market || marketScore === null) return 'Low';
  if (market.tradeFrequency !== null) {
    if (market.tradeFrequency >= 2) return 'High';
    if (market.tradeFrequency >= 0.5) return 'Moderate';
  }
  if (marketScore >= 800) return 'High';
  if (marketScore >= 450) return 'Moderate';
  return 'Low';
}

function riskBandFor(availability: number): RiskBand {
  if (availability >= 0.85) return 'Low';
  if (availability >= 0.65) return 'Moderate';
  return 'High';
}
