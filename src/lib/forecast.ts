/**
 * Weekly player forecasts — as distributions, not point estimates.
 *
 * Every other number in this app is a point estimate. That is fine for "how
 * good is this player", but it is the wrong shape for the two questions a
 * manager actually asks on a Sunday: *what is my floor* and *can I still win*.
 * Both need the spread, and the spread is not something we can assert — it has
 * to be measured against what projections have historically done.
 *
 * So this module fits, per position group, the conditional distribution of a
 * player's real custom-scored result given his projection, using every
 * projected player-week the app has already loaded. Three properties of that
 * distribution matter and all three are measured rather than assumed:
 *
 *  - **It is biased.** Projections are not centred on the outcome. Correcting
 *    that median shift is the cheapest accuracy win available, and it is what
 *    makes our central estimate better than the raw projection we started from.
 *
 *  - **It is heteroskedastic.** A 20-point projection is wrong by more points
 *    than a 5-point projection, so a single leaguewide error bar would be far
 *    too wide at the bottom of a roster and far too narrow at the top. The
 *    scale is fit as a line in the projection level.
 *
 *  - **It is skewed.** Fantasy outcomes are not normal — the upside tail is
 *    much longer than the downside one, because a player's floor is bounded near
 *    zero while his ceiling is a three-touchdown game. Assuming normality would
 *    understate every ceiling and overstate every floor. Instead the shape is
 *    carried as the empirical quantiles of the standardised residual, so
 *    whatever skew and fat-tailedness the real data has survives into the
 *    forecast.
 *
 * A fourth property matters only once scores are added up into a team total:
 * players are **correlated**. Two players in the same NFL game share a game
 * script, a pace and a weather report. Treating them as independent is the
 * classic way to build a simulator that is confidently wrong — team-total
 * variance comes out far too low, and every win probability gets pushed toward
 * 0 or 1. The average within-team-week correlation is estimated here and
 * applied in `simulate.ts` through a Gaussian copula, which induces the
 * dependence without disturbing any of the marginal shapes fit above.
 */

import { createScorer, groupForPlayer, hasPlayed, hasValidProjection, type ScoringModel } from './scoring';
import { clamp, mean, round, stdev } from './stats';
import type { Player, PositionGroup, StatLine } from './types';
import { POSITION_GROUPS } from './types';

/**
 * Projections below this are not evidence of anything — they are Sleeper's way
 * of listing a player who is not expected to play. Including them would load the
 * fit with thousands of near-zero pairs and drag the fitted intercept down.
 */
const MIN_MEANINGFUL_PROJECTION = 1;

/** Number of quantile knots kept for the standardised-residual shape. */
const SHAPE_KNOTS = 257;

/** Target bin count and minimum bin population for the scale fit. */
const SCALE_BINS = 10;
const MIN_BIN_SAMPLES = 60;

/** Floor on the fitted scale, so a near-zero projection still carries spread. */
const MIN_SCALE = 0.75;

/** Strength of the prior pulling a player's own play rate toward his group's. */
const PLAY_RATE_PRIOR = 4;

/** Weeks of neutral prior mixed into a player's own projection bias. */
const BIAS_PRIOR = 6;
/** How many recent weeks form the short-window half of the bias estimate. */
const RECENT_BIAS_WEEKS = 3;

/**
 * Per-player projection-bias correction, by position.
 *
 * Some players are persistently mis-projected, and that persistence is worth
 * points — but only in defensive positions. Measured over 2021–2025 with
 * seasons split discovery / validation / holdout (`npm run research:matchup`),
 * applying this correction moves holdout MAE by:
 *
 *     LB  +4.2%    DB  +3.8%    DL  +1.4%    everyone else  ~0
 *
 * The asymmetry is not a quirk of the fit, it is a fact about the data source.
 * Sleeper models quarterbacks and skill players carefully, so their residuals
 * are close to noise and chasing them adds nothing. IDP projections are much
 * cruder — closer to positional averages — so an individual linebacker's gap
 * between projection and reality is real, stable, and never corrected upstream.
 *
 * `damping` is how far to trust the estimate and `seasonWeight` splits it
 * between a season-long shrunk bias and a recent-form one. Both were chosen on
 * validation seasons only; holdout was read once, afterwards.
 */
export const BIAS_CORRECTION: Record<
  PositionGroup,
  { seasonWeight: number; damping: number }
> = {
  QB: { seasonWeight: 1, damping: 0.45 },
  RB: { seasonWeight: 0.5, damping: 0 },
  WR: { seasonWeight: 1, damping: 0.45 },
  TE: { seasonWeight: 0.75, damping: 0 },
  K: { seasonWeight: 0.5, damping: 0 },
  DL: { seasonWeight: 0.75, damping: 0.3 },
  LB: { seasonWeight: 0.75, damping: 1 },
  DB: { seasonWeight: 0.75, damping: 0.8 },
};

export interface ResidualFit {
  group: PositionGroup;
  /** Projected player-weeks the fit is built from. */
  samples: number;
  /** sd(actual − projected) ≈ scaleIntercept + scaleSlope × projected. */
  scaleIntercept: number;
  scaleSlope: number;
  /**
   * Empirical quantiles of the standardised residual at evenly spaced
   * probabilities, index 0 = minimum, last = maximum. This *is* the shape:
   * skew, kurtosis and all.
   */
  shape: number[];
  /** Median standardised residual — the projection's bias, in scale units. */
  medianZ: number;
  meanZ: number;
  sdZ: number;
  /** Lowest custom score the group has actually recorded; the sampling floor. */
  floor: number;
  /**
   * Mean pairwise correlation among players of *this group* on the same NFL
   * team — two linebackers competing for the same tackles, say. Reported as a
   * diagnostic; the simulator uses the model-level figure instead, for the
   * reason given there.
   */
  withinGroupCorrelation: number;
  /** P(records a stat line | carried a meaningful projection). */
  playRate: number;
}

export interface ResidualModel {
  byGroup: Map<PositionGroup, ResidualFit>;
  /**
   * Mean pairwise correlation of standardised residuals among *all* players
   * sharing an NFL team-week, pooled across position groups.
   *
   * Pooled deliberately. Measuring correlation inside a single position group
   * mostly measures nothing: an NFL team fields one quarterback and one kicker,
   * so those groups contain no pairs at all and the estimate collapses to zero.
   * The dependence that actually drives a fantasy team's variance is the shared
   * game environment — pace, script, weather — and that is cross-positional by
   * nature, linking a quarterback to his receivers and to the defence on the
   * other sideline. This is the number the simulator loads onto its shared shock.
   */
  teamCorrelation: number;
  /**
   * Per-player attendance, counted only over weeks the player was actually
   * projected for: `played / projected`.
   *
   * Conditioning on the projection is the whole point. A raw share of season
   * weeks would count every bye as an absence, capping even a player who never
   * misses a snap at about 16/17 — and since a forecast is only ever built for
   * a player who *has* a projection this week, a bye is already excluded by
   * that. Using the unconditional rate would apply the bye haircut a second
   * time and quietly shave every team total by about a tenth.
   */
  playsByPlayer: Map<string, { played: number; projected: number }>;
  /**
   * Each player's own history against his projection, in points: a running sum
   * for the season-long view and the last few weeks for the recent one.
   */
  biasByPlayer: Map<string, { sum: number; n: number; recent: number[] }>;
  /** Weeks the fit was built over. */
  throughWeek: number;
  totalSamples: number;
}

export interface FitResidualModelInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekTeams?: Map<number, Record<string, string>>;
  throughWeek: number;
}

interface Pair {
  pid: string;
  projection: number;
  actual: number;
  week: number;
  team: string;
}

/**
 * Weighted least squares of `y = a + b·x` over binned points.
 *
 * Bins rather than raw pairs because the quantity being regressed is a standard
 * deviation, which only exists for a group of observations.
 */
function fitScaleLine(
  bins: Array<{ x: number; y: number; w: number }>,
): { intercept: number; slope: number } {
  const totalWeight = bins.reduce((sum, bin) => sum + bin.w, 0);
  if (bins.length < 2 || totalWeight <= 0) {
    const flat = bins.length ? mean(bins.map((bin) => bin.y)) : MIN_SCALE;
    return { intercept: Math.max(MIN_SCALE, flat), slope: 0 };
  }

  const meanX = bins.reduce((sum, bin) => sum + bin.w * bin.x, 0) / totalWeight;
  const meanY = bins.reduce((sum, bin) => sum + bin.w * bin.y, 0) / totalWeight;

  let covariance = 0;
  let variance = 0;
  for (const bin of bins) {
    covariance += bin.w * (bin.x - meanX) * (bin.y - meanY);
    variance += bin.w * (bin.x - meanX) ** 2;
  }

  // A negative slope would say big projections are *more* certain in absolute
  // points, which is not a thing that happens; treat it as a flat fit.
  const slope = variance > 0 ? Math.max(0, covariance / variance) : 0;
  const intercept = Math.max(MIN_SCALE, meanY - slope * meanX);
  return { intercept, slope };
}

/** Empirical quantiles at `knots` evenly spaced probabilities. */
function quantileKnots(sorted: number[], knots: number): number[] {
  const out = new Array<number>(knots);
  const last = sorted.length - 1;
  for (let i = 0; i < knots; i++) {
    const pos = (i / (knots - 1)) * last;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sorted[base + 1];
    out[i] = next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
  }
  return out;
}

/**
 * Mean pairwise correlation of standardised residuals inside an NFL team-week.
 *
 * A method-of-moments estimator: across every team-week group, the sum of
 * centred pairwise products divided by the number of pairs estimates the average
 * covariance, which divided by the variance is the correlation. Doing it this
 * way avoids ever materialising a player-by-player matrix.
 *
 * Centring is not optional here. The residuals carry a real bias — that is the
 * whole reason the median correction exists — and an uncentred estimator would
 * report that squared bias as if it were correlation, which is exactly the size
 * of the effect being measured.
 */
function estimateTeamCorrelation(groups: number[][]): number {
  let count = 0;
  let sum = 0;
  for (const values of groups) {
    for (const v of values) {
      sum += v;
      count++;
    }
  }
  if (count < 2) return 0;

  const centre = sum / count;
  let variance = 0;
  for (const values of groups) {
    for (const v of values) variance += (v - centre) ** 2;
  }
  variance /= count;
  if (variance <= 0) return 0;

  let pairSum = 0;
  let pairCount = 0;

  for (const values of groups) {
    const n = values.length;
    if (n < 2) continue;
    let total = 0;
    let totalSquares = 0;
    for (const v of values) {
      const centred = v - centre;
      total += centred;
      totalSquares += centred * centred;
    }
    // (Σz)² − Σz² = 2·Σ_{i<j} z_i z_j, i.e. twice the sum over unordered pairs.
    pairSum += (total * total - totalSquares) / 2;
    pairCount += (n * (n - 1)) / 2;
  }

  if (!pairCount) return 0;
  /*
   * Clamped to [0, 0.9): a single-factor copula loads on sqrt(rho) and cannot
   * represent a negative shared factor, and a correlation near 1 would collapse
   * every player on a team onto one draw.
   */
  return clamp(pairSum / pairCount / variance, 0, 0.9);
}

/**
 * Fits the residual model from loaded season data.
 *
 * Only weeks that are complete contribute: a partially played week would pair
 * full projections against partial results and manufacture a huge downside tail.
 */
export function fitResidualModel(input: FitResidualModelInput): ResidualModel {
  const { scoringModel, playersById, weekStats, weekProjections, weekTeams, throughWeek } = input;
  const score = createScorer(scoringModel);

  const pairsByGroup = new Map<PositionGroup, Pair[]>();
  const playCounts = new Map<PositionGroup, { played: number; projected: number }>();
  const playsByPlayer = new Map<string, { played: number; projected: number }>();
  const biasByPlayer = new Map<string, { sum: number; n: number; recent: number[] }>();
  for (const group of POSITION_GROUPS) {
    pairsByGroup.set(group, []);
    playCounts.set(group, { played: 0, projected: 0 });
  }

  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    const projections = weekProjections.get(week);
    if (!stats || !projections) continue;
    const teams = weekTeams?.get(week) ?? {};

    for (const pid of Object.keys(projections)) {
      const projLine = projections[pid];
      if (!hasValidProjection(projLine)) continue;

      const group = groupForPlayer(playersById.get(pid));
      if (!group) continue;

      const projection = score(projLine);
      if (projection < MIN_MEANINGFUL_PROJECTION) continue;

      const counts = playCounts.get(group)!;
      counts.projected++;

      let own = playsByPlayer.get(pid);
      if (!own) {
        own = { played: 0, projected: 0 };
        playsByPlayer.set(pid, own);
      }
      own.projected++;

      const statLine = stats[pid];
      if (!hasPlayed(statLine)) continue;
      counts.played++;
      own.played++;

      pairsByGroup.get(group)!.push({
        pid,
        projection,
        actual: score(statLine),
        week,
        team: teams[pid] ?? '',
      });
    }
  }

  const byGroup = new Map<PositionGroup, ResidualFit>();
  let totalSamples = 0;
  /** Standardised residuals keyed by NFL team-week, pooled across positions. */
  const pooledTeamWeeks = new Map<string, number[]>();

  for (const group of POSITION_GROUPS) {
    const pairs = pairsByGroup.get(group)!;
    const counts = playCounts.get(group)!;
    if (pairs.length < MIN_BIN_SAMPLES) continue;

    // ---- Scale: sd of the residual as a line in the projection level --------
    const byProjection = [...pairs].sort((a, b) => a.projection - b.projection);
    const binCount = Math.max(
      1,
      Math.min(SCALE_BINS, Math.floor(byProjection.length / MIN_BIN_SAMPLES)),
    );
    const binSize = Math.ceil(byProjection.length / binCount);

    const bins: Array<{ x: number; y: number; w: number }> = [];
    for (let start = 0; start < byProjection.length; start += binSize) {
      const slice = byProjection.slice(start, start + binSize);
      if (slice.length < 2) continue;
      bins.push({
        x: mean(slice.map((p) => p.projection)),
        y: stdev(slice.map((p) => p.actual - p.projection)),
        w: slice.length,
      });
    }

    const { intercept, slope } = fitScaleLine(bins);

    // ---- Shape: the standardised residual, kept as empirical quantiles ------
    const standardised = pairs.map((pair) => ({
      ...pair,
      z: (pair.actual - pair.projection) / Math.max(MIN_SCALE, intercept + slope * pair.projection),
    }));
    const sortedZ = standardised.map((pair) => pair.z).sort((a, b) => a - b);

    /*
     * Per-player bias is carried in standardised units, not points, for two
     * reasons. It makes a linebacker projected for 4 and one projected for 14
     * directly comparable, and it lets the shift be re-scaled to whatever this
     * week's projection is rather than assuming the miss is a fixed number of
     * points regardless of workload.
     */
    for (const pair of standardised) {
      let bias = biasByPlayer.get(pair.pid);
      if (!bias) {
        bias = { sum: 0, n: 0, recent: [] };
        biasByPlayer.set(pair.pid, bias);
      }
      bias.sum += pair.z;
      bias.n++;
      bias.recent.push(pair.z);
      if (bias.recent.length > RECENT_BIAS_WEEKS) bias.recent.shift();
    }

    // ---- Correlation: standardised residuals grouped by NFL team-week -------
    const teamWeeks = new Map<string, number[]>();
    for (const pair of standardised) {
      if (!pair.team) continue;
      const key = `${pair.week}:${pair.team}`;
      const bucket = teamWeeks.get(key);
      if (bucket) bucket.push(pair.z);
      else teamWeeks.set(key, [pair.z]);

      const pooled = pooledTeamWeeks.get(key);
      if (pooled) pooled.push(pair.z);
      else pooledTeamWeeks.set(key, [pair.z]);
    }

    const shape = quantileKnots(sortedZ, Math.min(SHAPE_KNOTS, sortedZ.length));

    byGroup.set(group, {
      group,
      samples: pairs.length,
      scaleIntercept: round(intercept, 4),
      scaleSlope: round(slope, 4),
      shape,
      medianZ: shape[(shape.length - 1) >> 1],
      meanZ: mean(sortedZ),
      sdZ: stdev(sortedZ),
      floor: Math.min(...pairs.map((pair) => pair.actual)),
      withinGroupCorrelation: estimateTeamCorrelation([...teamWeeks.values()]),
      playRate: counts.projected ? counts.played / counts.projected : 1,
    });
    totalSamples += pairs.length;
  }

  return {
    byGroup,
    teamCorrelation: estimateTeamCorrelation([...pooledTeamWeeks.values()]),
    playsByPlayer,
    biasByPlayer,
    throughWeek,
    totalSamples,
  };
}

/** Fitted residual scale at a given projection level. */
export function scaleFor(fit: ResidualFit, projection: number): number {
  return Math.max(MIN_SCALE, fit.scaleIntercept + fit.scaleSlope * Math.max(0, projection));
}

/**
 * Inverse CDF of the standardised residual, linearly interpolated between knots.
 *
 * This is what turns a uniform draw into a residual with the right shape, and
 * what makes the copula in `simulate.ts` preserve these marginals exactly.
 */
export function quantileOfZ(fit: ResidualFit, u: number): number {
  const knots = fit.shape;
  const last = knots.length - 1;
  const pos = clamp(u, 0, 1) * last;
  const base = Math.floor(pos);
  if (base >= last) return knots[last];
  return knots[base] + (pos - base) * (knots[base + 1] - knots[base]);
}

/**
 * How many points to shift a player's forecast for his own projection bias.
 *
 * Zero for any position where the correction did not earn its place out of
 * sample — see `BIAS_CORRECTION`. The season-long estimate is shrunk toward no
 * bias by `BIAS_PRIOR` weeks, so three good games cannot assert a large one.
 */
export function biasShiftFor(
  model: ResidualModel,
  pid: string,
  group: PositionGroup,
  projection: number,
): number {
  const { seasonWeight, damping } = BIAS_CORRECTION[group];
  if (damping <= 0) return 0;

  const fit = model.byGroup.get(group);
  const bias = model.biasByPlayer.get(pid);
  if (!fit || !bias || !bias.n) return 0;

  /*
   * Measured as an excess over the player's own position, never as an absolute
   * bias. The forecast has already moved the whole group, so adding a player's
   * raw bias on top would count the group's share of it a second time — which
   * is what the first attempt did, pulling every simulated team total about nine
   * percent low.
   *
   * The reference is the group *mean*, not its median, and the distinction is
   * not pedantic. The statistic being compared is a player's average residual,
   * and residuals are right-skewed, so the group mean sits above the group
   * median. Differencing a mean against a median hands every single player a
   * small positive excess and inflates the league by about five percent — the
   * same bug in the opposite direction. Like against like keeps the average
   * correction at zero, which is what makes this a redistribution between
   * players rather than a thumb on the scale.
   */
  const season = (bias.sum - bias.n * fit.meanZ) / (bias.n + BIAS_PRIOR);
  const recent = bias.recent.length
    ? bias.recent.reduce((sum, v) => sum + v, 0) / bias.recent.length - fit.meanZ
    : season;

  const excessZ = seasonWeight * season + (1 - seasonWeight) * recent;
  return damping * scaleFor(fit, projection) * excessZ;
}

/**
 * Score at probability `u`, conditional on the player actually playing.
 *
 * `shift` moves the location without touching the spread: the scale was fit
 * against the raw projection level, so a corrected player keeps the error bar
 * that a projection of his size has historically earned.
 */
export function scoreAtQuantile(
  fit: ResidualFit,
  projection: number,
  u: number,
  shift = 0,
): number {
  return Math.max(
    fit.floor,
    projection + shift + scaleFor(fit, projection) * quantileOfZ(fit, u),
  );
}

/** CDF of the standardised residual — the inverse of `quantileOfZ`. */
export function cdfOfZ(fit: ResidualFit, z: number): number {
  const knots = fit.shape;
  const last = knots.length - 1;
  if (z <= knots[0]) return 0;
  if (z >= knots[last]) return 1;

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (knots[mid] <= z) low = mid;
    else high = mid;
  }

  const span = knots[high] - knots[low];
  const within = span > 0 ? (z - knots[low]) / span : 0;
  return (low + within) / last;
}

export interface PlayerForecast {
  pid: string;
  group: PositionGroup;
  /** The custom-scored source projection, exactly as the app scores it today. */
  projection: number;
  /** Bias-corrected central estimate — our number, not the source's. */
  median: number;
  /** Points added for this player's own history against his projection. */
  biasShift: number;
  mean: number;
  sd: number;
  /** Unconditional quantiles: the DNP mass is folded in, so a floor can be 0. */
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** Probability the player records a stat line at all. */
  playProb: number;
  /** The player's real result, when the week has already been played. */
  actual: number | null;
  /** NFL team, used to group correlated players when simulating. */
  nflTeam: string;
}

export interface BuildWeekForecastInput {
  model: ResidualModel;
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** Projections for the target week. */
  projections: Record<string, StatLine>;
  /** Results for the target week, where they exist. */
  stats?: Record<string, StatLine>;
  teams?: Record<string, string>;
  /** Players known to be unavailable this week. */
  isOut?: (pid: string) => boolean;
  /** Restrict the build to these players. Omit to forecast everyone projected. */
  only?: Set<string>;
}

/**
 * Unconditional quantile of the score, mixing the DNP mass in at zero.
 *
 * A player who misses 15% of weeks genuinely has a 10th-percentile outcome of
 * zero, and a floor that quietly assumed he suits up would be dishonest in
 * exactly the situation the floor exists to warn about.
 *
 * Not simply "shift by the DNP mass": a played game can itself score at or
 * below zero — a quarterback throwing two interceptions, a receiver losing a
 * fumble — so the distribution has real mass on both sides of the atom at zero.
 * The three branches below are that atom and its two tails.
 */
function mixtureQuantile(
  fit: ResidualFit,
  projection: number,
  playProb: number,
  q: number,
  shift: number,
): number {
  if (playProb <= 0) return 0;
  if (playProb >= 1) return scoreAtQuantile(fit, projection, q, shift);

  // Probability a played game finishes at or below zero.
  const belowZero = cdfOfZ(fit, (0 - projection - shift) / scaleFor(fit, projection));
  const negativeMass = playProb * belowZero;

  if (q < negativeMass) return scoreAtQuantile(fit, projection, q / playProb, shift);
  if (q <= negativeMass + (1 - playProb)) return 0;
  return scoreAtQuantile(fit, projection, (q - (1 - playProb)) / playProb, shift);
}

export function buildWeekForecast(input: BuildWeekForecastInput): Map<string, PlayerForecast> {
  const { model, scoringModel, playersById, projections, stats, teams, isOut, only } = input;
  const score = createScorer(scoringModel);
  const out = new Map<string, PlayerForecast>();

  const pids = only ? [...only] : Object.keys(projections);

  for (const pid of pids) {
    const group = groupForPlayer(playersById.get(pid));
    if (!group) continue;
    const fit = model.byGroup.get(group);
    if (!fit) continue;

    const projLine = projections[pid];
    const projection = hasValidProjection(projLine) ? score(projLine) : 0;

    const statLine = stats?.[pid];
    const played = hasPlayed(statLine);
    const actual = played ? score(statLine) : null;

    /*
     * Play probability. A player Sleeper does not project for this week is on a
     * bye or inactive, and a player flagged out is out — both are certainties,
     * not estimates. Otherwise the player's own record of turning up *when
     * projected* is shrunk toward his position's base rate, because six healthy
     * weeks is weak evidence of a 100% floor.
     */
    let playProb: number;
    if (played) {
      playProb = 1;
    } else if (projection < MIN_MEANINGFUL_PROJECTION || isOut?.(pid)) {
      playProb = 0;
    } else {
      const own = model.playsByPlayer.get(pid);
      playProb = own
        ? (own.played + fit.playRate * PLAY_RATE_PRIOR) / (own.projected + PLAY_RATE_PRIOR)
        : fit.playRate;
      playProb = clamp(playProb, 0, 1);
    }

    const scale = scaleFor(fit, projection);
    const shift = biasShiftFor(model, pid, group, projection);
    const conditionalMean = projection + shift + scale * fit.meanZ;
    const conditionalSd = scale * fit.sdZ;

    out.set(pid, {
      pid,
      group,
      projection: round(projection),
      biasShift: round(shift),
      median: round(projection + shift + scale * fit.medianZ),
      mean: round(conditionalMean * playProb),
      // Variance of the DNP mixture: within-branch variance plus the spread
      // between a zero and a played outcome.
      sd: round(
        Math.sqrt(
          playProb * conditionalSd ** 2 + playProb * (1 - playProb) * conditionalMean ** 2,
        ),
      ),
      p10: round(mixtureQuantile(fit, projection, playProb, 0.1, shift)),
      p25: round(mixtureQuantile(fit, projection, playProb, 0.25, shift)),
      p75: round(mixtureQuantile(fit, projection, playProb, 0.75, shift)),
      p90: round(mixtureQuantile(fit, projection, playProb, 0.9, shift)),
      playProb: round(playProb, 3),
      actual: actual === null ? null : round(actual),
      nflTeam: (teams?.[pid] ?? playersById.get(pid)?.team ?? '').toUpperCase(),
    });
  }

  return out;
}
