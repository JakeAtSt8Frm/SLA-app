/**
 * Position-specific age / longevity curves for dynasty valuation.
 *
 * Age cannot be read the same way across positions: a 29-year-old running back
 * and a 29-year-old quarterback have wildly different runways. Each curve maps
 * age to a 0..1 longevity multiplier (1 = full career ahead, 0 = end of the
 * useful window), interpolated linearly between control points and flat outside
 * them. The shapes encode the well-worn dynasty consensus — the running-back
 * cliff, the longer receiver and quarterback windows, the late tight-end
 * breakout — rather than any single hard cutoff.
 */

import type { Player, PositionGroup } from './types';

/** Control points: [age, longevityMultiplier], ascending by age. */
const CURVES: Record<PositionGroup, Array<[number, number]>> = {
  // Quarterbacks hold value deep into their 30s when the job is secure.
  QB: [
    [23, 1.0],
    [30, 0.92],
    [34, 0.78],
    [38, 0.5],
    [42, 0.3],
  ],
  // The running-back cliff: value falls off a shelf in the late 20s.
  RB: [
    [21, 1.0],
    [24, 0.95],
    [26, 0.78],
    [28, 0.55],
    [30, 0.32],
    [32, 0.15],
  ],
  // Receivers age more gracefully than backs but faster than passers.
  WR: [
    [22, 1.0],
    [26, 0.95],
    [29, 0.75],
    [31, 0.55],
    [33, 0.35],
    [35, 0.2],
  ],
  // Tight ends break out late and hold a plateau before a gentle decline.
  TE: [
    [23, 0.95],
    [25, 1.0],
    [29, 0.9],
    [31, 0.7],
    [33, 0.5],
    [35, 0.3],
  ],
  // Interior line and EDGE stay productive relatively late.
  DL: [
    [23, 1.0],
    [28, 0.92],
    [31, 0.75],
    [33, 0.55],
    [35, 0.35],
  ],
  // Off-ball linebackers can lose snap share quickly once athleticism dips.
  LB: [
    [23, 1.0],
    [27, 0.92],
    [30, 0.7],
    [32, 0.5],
    [34, 0.3],
  ],
  // Defensive backs sit between the two; role changes drive most of the risk.
  DB: [
    [23, 1.0],
    [28, 0.9],
    [31, 0.68],
    [33, 0.48],
    [35, 0.3],
  ],
  // Kickers are effectively age-agnostic within any dynasty horizon.
  K: [
    [24, 1.0],
    [40, 0.9],
  ],
};

/** Neutral value when a player's age is unknown — a mild, honest discount. */
const UNKNOWN_AGE = 0.6;

/** Longevity multiplier (0..1) for a player of `age` in `group`. */
export function longevity(group: PositionGroup, age: number | null): number {
  if (age === null || !Number.isFinite(age)) return UNKNOWN_AGE;
  const curve = CURVES[group];
  if (!curve || !curve.length) return UNKNOWN_AGE;

  if (age <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (age >= last[0]) return last[1];

  for (let i = 1; i < curve.length; i++) {
    const [a1, v1] = curve[i];
    if (age <= a1) {
      const [a0, v0] = curve[i - 1];
      const t = (age - a0) / (a1 - a0);
      return v0 + t * (v1 - v0);
    }
  }
  return last[1];
}

/**
 * Resolves a player's age. Sleeper usually carries `age` directly; when it is
 * missing we derive it from the birth date so young players (whose `age` field
 * is occasionally absent pre-season) still get a curve.
 */
export function resolveAge(player: Player | undefined | null): number | null {
  if (!player) return null;
  if (typeof player.age === 'number' && Number.isFinite(player.age)) return player.age;
  if (player.birth_date) {
    const born = Date.parse(player.birth_date);
    if (!Number.isNaN(born)) {
      const years = (Date.now() - born) / (365.25 * 24 * 3600 * 1000);
      if (years > 0 && years < 60) return Math.floor(years * 10) / 10;
    }
  }
  return null;
}
