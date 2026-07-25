/**
 * Dynasty market values — the one signal Sleeper cannot provide.
 *
 * The in-season Value Score is built entirely from production. A *dynasty*
 * valuation also needs to know what the market currently pays, because the whole
 * point of a dynasty model is the gap between intrinsic worth and market price
 * (buy-low / sell-high). FantasyCalc publishes that number for free as a plain
 * JSON feed keyed by Sleeper player id, which is exactly what lets this stay a
 * backend-less static site.
 *
 * Everything here is best-effort: the feed is a third party, so a failure must
 * degrade to "no market data" rather than break the load. The dynasty model
 * treats a missing market value as neutral, which is also what happens for IDPs
 * — FantasyCalc only values offensive players and picks, so DL/LB/DB legitimately
 * come back empty and fall back to their production-only valuation.
 */

const FANTASYCALC = 'https://api.fantasycalc.com/values/current';

/** One player's dynasty market snapshot, normalised to what the model reads. */
export interface MarketEntry {
  /** FantasyCalc dynasty value (arbitrary units; only relative size matters). */
  value: number;
  /** Overall market rank across all valued assets, 1 = most valuable. */
  overallRank: number;
  /** Rank within the player's own position. */
  positionRank: number;
  /** 30-day value change; sign gives the market trend. */
  trend30Day: number;
  /** Redraft value, for the redraft-vs-dynasty gap (contender lens). */
  redraftValue: number | null;
  /** Startup ADP when the feed carries one. */
  adp: number | null;
  /** How often the asset actually trades — a liquidity proxy. */
  tradeFrequency: number | null;
}

interface RawFantasyCalcEntry {
  player?: { sleeperId?: string | null; position?: string | null };
  value?: number;
  overallRank?: number;
  positionRank?: number;
  trend30Day?: number;
  redraftValue?: number | null;
  maybeAdp?: number | null;
  maybeTradeFrequency?: number | null;
}

/** Shape of the league inputs that steer the value feed to the right format. */
export interface MarketQuery {
  /** 1 for one-QB, 2 for superflex / two-QB. */
  numQbs: number;
  numTeams: number;
  /** Points per reception (0, 0.5, 1). */
  ppr: number;
}

/**
 * Derives the market query from the league's own settings so the values match
 * the format being scored — a superflex QB is worth far more than a 1-QB one,
 * and the feed knows the difference if we ask for it correctly.
 */
export function marketQueryFromLeague(
  rosterPositions: string[] | undefined,
  totalRosters: number | undefined,
  rec: number | undefined,
): MarketQuery {
  const positions = rosterPositions ?? [];
  const superflex = positions.some((p) => p === 'SUPER_FLEX' || p === 'OP' || p === 'QB/RB/WR/TE');
  return {
    numQbs: superflex ? 2 : 1,
    numTeams: totalRosters && totalRosters > 0 ? totalRosters : 12,
    ppr: typeof rec === 'number' ? rec : 0.5,
  };
}

/**
 * Fetches current dynasty market values keyed by Sleeper player id.
 *
 * Returns an empty map on any failure; the model reads a missing entry as a
 * neutral market signal rather than a zero.
 */
export async function getMarketValues(
  query: MarketQuery,
  signal?: AbortSignal,
): Promise<Map<string, MarketEntry>> {
  const url =
    `${FANTASYCALC}?isDynasty=true` +
    `&numQbs=${query.numQbs}` +
    `&numTeams=${query.numTeams}` +
    `&ppr=${query.ppr}`;

  const out = new Map<string, MarketEntry>();
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return out;
    const raw = (await res.json()) as RawFantasyCalcEntry[];
    if (!Array.isArray(raw)) return out;

    for (const entry of raw) {
      const pid = entry.player?.sleeperId;
      if (!pid || typeof entry.value !== 'number') continue;
      out.set(String(pid), {
        value: entry.value,
        overallRank: entry.overallRank ?? 0,
        positionRank: entry.positionRank ?? 0,
        trend30Day: entry.trend30Day ?? 0,
        redraftValue: typeof entry.redraftValue === 'number' ? entry.redraftValue : null,
        adp: typeof entry.maybeAdp === 'number' ? entry.maybeAdp : null,
        tradeFrequency:
          typeof entry.maybeTradeFrequency === 'number' ? entry.maybeTradeFrequency : null,
      });
    }
  } catch {
    /* Third-party feed — a failure means "no market data", never a broken load. */
  }
  return out;
}
