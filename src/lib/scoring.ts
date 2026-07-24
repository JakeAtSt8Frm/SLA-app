/**
 * The custom scoring engine.
 *
 * This is the heart of the app. Every number shown anywhere — projections,
 * actuals, value scores, matchup ratings, optimal lineups — traces back to
 * `scoreStatLine`. We deliberately do NOT use Sleeper's precomputed `pts_ppr`
 * or `pts_half_ppr` fields: this league's settings (superflex, TE premium,
 * heavily weighted IDP) diverge far enough from any standard format that those
 * numbers would be wrong. Instead we multiply the league's own 140-key
 * scoring_settings against the raw stat line, the same way Sleeper does
 * internally.
 */

import type { Player, PositionGroup, ScoringSettings, StatLine } from './types';
import { POSITION_TO_GROUP } from './types';

/**
 * Compiled form of a league's scoring settings.
 *
 * Building this once and reusing it matters: a season of stats is ~2000 players
 * x 18 weeks, and iterating 140 `Object.entries` per call was the single
 * hottest path in the original app.
 */
export interface ScoringModel {
  /** Only the stat keys with a non-zero multiplier, in a flat pair array. */
  keys: string[];
  multipliers: number[];
  raw: ScoringSettings;
}

/** Compiles league scoring settings into a fast, reusable scoring model. */
export function compileScoring(settings: ScoringSettings | undefined | null): ScoringModel {
  const keys: string[] = [];
  const multipliers: number[] = [];

  if (settings) {
    for (const [key, mult] of Object.entries(settings)) {
      // Zero-weighted keys can never affect the total, so drop them at compile
      // time. This league declares 140 keys but only ~60 actually score.
      if (typeof mult === 'number' && mult !== 0 && Number.isFinite(mult)) {
        keys.push(key);
        multipliers.push(mult);
      }
    }
  }

  return { keys, multipliers, raw: settings ?? {} };
}

/**
 * Scores a single raw stat line under the league's custom scoring settings.
 *
 * Rounded to 2dp to match Sleeper's own display rounding, which keeps our
 * per-player numbers summing to the same team total Sleeper reports.
 */
export function scoreStatLine(model: ScoringModel, stats: StatLine | undefined | null): number {
  if (!stats) return 0;

  let total = 0;
  const { keys, multipliers } = model;
  for (let i = 0; i < keys.length; i++) {
    const v = stats[keys[i]];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v * multipliers[i];
    }
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Memoising wrapper around `scoreStatLine`.
 *
 * Stat line objects are stable across a session (they come straight out of the
 * fetch cache), so a WeakMap keyed on the object identity gives us free
 * deduplication without any invalidation logic.
 */
export function createScorer(model: ScoringModel) {
  const cache = new WeakMap<object, number>();

  return function score(stats: StatLine | undefined | null): number {
    if (!stats) return 0;
    const cached = cache.get(stats);
    if (cached !== undefined) return cached;
    const value = scoreStatLine(model, stats);
    cache.set(stats, value);
    return value;
  };
}

export type Scorer = ReturnType<typeof createScorer>;

/**
 * Stat keys that indicate a player actually took the field.
 *
 * A player can appear in a week's stats payload with only contextual fields
 * (team, opponent, game id) if they were inactive, so presence in the map is
 * not sufficient. We look for any real participation signal — including IDP
 * tackle counts, since in this league a defender who only records tackles is
 * still very much "played".
 */
const PARTICIPATION_KEYS = [
  'gp',
  'off_snp',
  'def_snp',
  'st_snp',
  'tm_off_snp',
  'pass_att',
  'rush_att',
  'rec_tgt',
  'rec',
  'idp_tkl',
  'idp_tkl_solo',
  'idp_tkl_ast',
  'tkl',
  'tkl_solo',
  'tkl_ast',
  'fga',
  'xpa',
] as const;

/** True when the stat line shows real game participation, not just a stub. */
export function hasPlayed(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key of PARTICIPATION_KEYS) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/**
 * True when a projection payload carries a usable forecast.
 *
 * Sleeper emits projection stubs for every rostered player, including ones with
 * no expectation of playing. Treating those as a 0.0 projection would flag every
 * inactive player as a "boom", so we require at least one non-zero projected
 * stat before trusting it.
 */
export function hasValidProjection(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key in stats) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/** Extracts snap percentage from a stat line, tolerating source key drift. */
export function snapPct(stats: StatLine | undefined | null): number | null {
  if (!stats) return null;

  const direct = stats.off_snp_pct ?? stats.snp_pct ?? stats.def_snp_pct;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    // Some payloads express this as 0..1 and others as 0..100.
    return direct <= 1 ? direct * 100 : direct;
  }

  // Otherwise derive it from raw snap counts against the team total.
  const teamSnaps = stats.tm_off_snp ?? stats.tm_def_snp;
  const playerSnaps = stats.off_snp ?? stats.def_snp;
  if (
    typeof teamSnaps === 'number' &&
    typeof playerSnaps === 'number' &&
    teamSnaps > 0
  ) {
    return (playerSnaps / teamSnaps) * 100;
  }

  return null;
}

/** Resolves a player's scoring-relevant position group. */
export function groupForPlayer(player: Player | undefined | null): PositionGroup | null {
  if (!player) return null;

  const candidates: string[] = [];
  if (player.position) candidates.push(player.position);
  if (Array.isArray(player.fantasy_positions)) candidates.push(...player.fantasy_positions);
  if (player.depth_chart_position) candidates.push(player.depth_chart_position);

  for (const raw of candidates) {
    const group = POSITION_TO_GROUP[String(raw).trim().toUpperCase()];
    if (group) return group;
  }

  return null;
}

/**
 * Opportunity volume for a player-week — a position-aware usage proxy.
 *
 * Volume is the most stable predictor of future scoring, so this feeds the
 * Value Score. For IDP we use snap-weighted tackle opportunities because raw
 * defensive box-score events are far noisier than offensive touches.
 */
export function opportunities(group: PositionGroup, stats: StatLine): number | null {
  const n = (key: string): number => {
    const v = stats[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  switch (group) {
    case 'QB':
      return n('pass_att') + n('rush_att');
    case 'RB':
      return n('rush_att') + n('rec_tgt');
    case 'WR':
    case 'TE':
      return n('rec_tgt');
    case 'K':
      return n('fga') + n('xpa');
    case 'DL':
    case 'LB':
    case 'DB': {
      // Tackles + pressure events approximate defensive involvement.
      const involvement =
        n('idp_tkl_solo') +
        n('idp_tkl_ast') +
        n('idp_qb_hit') +
        n('idp_sack') +
        n('idp_pass_def');
      return involvement > 0 ? involvement : null;
    }
    default:
      return null;
  }
}

/**
 * Efficiency proxy for a player-week: points produced per opportunity.
 *
 * Kept position-aware so a kicker's per-attempt rate isn't compared against a
 * receiver's per-target rate. Returns null when volume is too small to be
 * meaningful, which the Value Score treats as neutral rather than as a zero.
 */
export function efficiency(
  group: PositionGroup,
  stats: StatLine,
  scored: number,
): number | null {
  const opps = opportunities(group, stats);
  if (opps === null || opps < 2) return null;
  return scored / opps;
}
