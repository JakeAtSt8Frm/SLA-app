/** Small numeric helpers shared by the metric models. */

export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 1);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Linear-interpolated quantile over an unsorted array. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

/** Sample standard deviation. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Converts raw values into 0..1 percentile ranks within their own pool.
 *
 * Ties share the average rank so that, for example, a cluster of players who
 * all scored zero don't get artificially spread across the bottom of the range.
 * Rank-percentile normalisation is used throughout instead of min/max scaling
 * because a single outlier week would otherwise compress everyone else.
 */
export function percentileRanks(entries: Array<{ id: string; value: number }>): Map<string, number> {
  const out = new Map<string, number>();
  if (!entries.length) return out;

  if (entries.length === 1) {
    out.set(entries[0].id, 0.5);
    return out;
  }

  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const denom = sorted.length - 1;

  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j++;
    const avgRank = (i + j) / 2;
    const pct = avgRank / denom;
    for (let k = i; k <= j; k++) out.set(sorted[k].id, pct);
    i = j + 1;
  }

  return out;
}

/**
 * Converts a 1-based rank into a 0..1 score where rank 1 maps to 1.0.
 *
 * Returns the neutral fallback when the player didn't meet the sample threshold
 * for ranking, so unranked players are neither rewarded nor punished.
 */
export function rankScore(
  rank: number | null | undefined,
  outOf: number,
  fallback = 0.5,
): number {
  if (!rank || !outOf || outOf < 2) return fallback;
  return clamp01((outOf - rank) / (outOf - 1));
}

/** Rounds to a fixed number of decimal places. */
export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
}
