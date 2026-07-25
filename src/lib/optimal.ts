/**
 * Optimal lineup solver.
 *
 * Given a pool of rostered players and the league's starting slots, find the
 * assignment that maximises total custom-scored points.
 *
 * NOTE ON CORRECTNESS: the original implementation filled fixed slots greedily
 * (best available player per slot, in a fixed slot order) and only then filled
 * flex slots. That is not guaranteed optimal in a superflex league. Concretely:
 * with one QB slot, one SUPER_FLEX, a 30-point QB and a 28-point QB, greedy
 * assigns the 30 to QB and the 28 to SUPER_FLEX — fine. But when the best
 * remaining flex-eligible option is a 29-point RB, greedy has already consumed
 * both QBs and misses nothing; the failure appears when a player is eligible
 * for a scarce fixed slot *and* a flex, and taking them for the flex frees a
 * better fixed-slot fill. This solver instead computes a true maximum-weight
 * bipartite matching, so the reported "optimal" number is genuinely optimal.
 *
 * The problem is tiny (≤21 slots, ≤50 players), so an exact Hungarian-style
 * augmenting-path algorithm is instant.
 */

import type { PositionGroup } from './types';

/** Slots that never hold a starter. */
const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI', 'TX', 'RESERVE']);

/**
 * Which position groups may fill each roster slot.
 *
 * Superflex (`SUPER_FLEX`) accepting QB is what makes this league's lineup
 * decisions non-trivial, and `IDP_FLEX` spans all three defensive groups.
 */
const SLOT_ELIGIBILITY: Record<string, PositionGroup[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  RBWR_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  WRTE_FLEX: ['WR', 'TE'],
  RBWRTE: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DP: ['DL', 'LB', 'DB'],
};

export function isStarterSlot(slot: string): boolean {
  return !BENCH_SLOTS.has(String(slot).toUpperCase());
}

export function slotAccepts(slot: string, group: PositionGroup | null): boolean {
  if (!group) return false;
  const allowed = SLOT_ELIGIBILITY[String(slot).toUpperCase()];
  return allowed ? allowed.includes(group) : false;
}

/** Extracts just the starting slots from a league's roster_positions. */
export function starterSlots(rosterPositions: string[] | undefined | null): string[] {
  return (rosterPositions ?? []).filter(isStarterSlot);
}

export interface LineupCandidate {
  pid: string;
  group: PositionGroup | null;
  points: number;
}

export interface LineupAssignment {
  slot: string;
  slotIndex: number;
  pid: string | null;
  points: number;
}

export interface OptimalLineup {
  assignments: LineupAssignment[];
  total: number;
  /** Players who scored but didn't make the optimal lineup. */
  benched: LineupCandidate[];
}

/**
 * Maximum-weight bipartite matching between slots and players.
 *
 * Uses the Hungarian algorithm's shortest-augmenting-path formulation (JV
 * style) over a slots x players cost matrix, where cost = -points. Ineligible
 * pairings get a large positive cost so they're never selected unless a slot
 * would otherwise go empty.
 */
function maxWeightAssignment(
  slots: string[],
  candidates: LineupCandidate[],
): Array<number | null> {
  const nSlots = slots.length;
  const realPlayers = candidates.length;
  if (!nSlots || !realPlayers) return new Array(nSlots).fill(null);

  /*
   * The shortest-augmenting-path form requires columns >= rows. Real rosters
   * normally satisfy that, but an incomplete roster (or a narrow filtered pool)
   * may not. Zero-point dummy columns represent empty slots and keep the solver
   * finite without ever surfacing as player assignments.
   */
  const nPlayers = Math.max(realPlayers, nSlots);

  const INELIGIBLE = 1e9;

  // cost[i][j] for slot i, player j. Negative points = maximise points.
  const cost: number[][] = [];
  for (let i = 0; i < nSlots; i++) {
    const row = new Array<number>(nPlayers);
    for (let j = 0; j < nPlayers; j++) {
      if (j >= realPlayers) {
        row[j] = 0;
        continue;
      }
      row[j] = slotAccepts(slots[i], candidates[j].group)
        ? -candidates[j].points
        : INELIGIBLE;
    }
    cost.push(row);
  }

  // Standard O(n^2 m) Hungarian with potentials. 1-indexed internal arrays.
  const u = new Array<number>(nSlots + 1).fill(0);
  const v = new Array<number>(nPlayers + 1).fill(0);
  const p = new Array<number>(nPlayers + 1).fill(0); // player -> slot
  const way = new Array<number>(nPlayers + 1).fill(0);

  for (let i = 1; i <= nSlots; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(nPlayers + 1).fill(Infinity);
    const used = new Array<boolean>(nPlayers + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= nPlayers; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= nPlayers; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result = new Array<number | null>(nSlots).fill(null);
  for (let j = 1; j <= realPlayers; j++) {
    const slotIdx = p[j] - 1;
    if (slotIdx >= 0 && slotIdx < nSlots) {
      // Reject assignments that were only made because a slot needed filling.
      if (cost[slotIdx][j - 1] < INELIGIBLE) result[slotIdx] = j - 1;
    }
  }

  return result;
}

/**
 * Computes the highest-scoring legal lineup from a pool of players.
 *
 * `points` is whatever metric the caller wants to optimise for — actual custom
 * score when looking backwards ("what was the best I could have done"), or a
 * projection/FIT blend when looking forwards.
 */
export function computeOptimalLineup(
  slots: string[],
  candidates: LineupCandidate[],
): OptimalLineup {
  const pool = candidates.filter((c) => c.group !== null);
  const matched = maxWeightAssignment(slots, pool);

  const assignments: LineupAssignment[] = [];
  const used = new Set<string>();
  let total = 0;

  for (let i = 0; i < slots.length; i++) {
    const idx = matched[i];
    if (idx === null || idx === undefined) {
      assignments.push({ slot: slots[i], slotIndex: i, pid: null, points: 0 });
      continue;
    }
    const chosen = pool[idx];
    used.add(chosen.pid);
    total += chosen.points;
    assignments.push({
      slot: slots[i],
      slotIndex: i,
      pid: chosen.pid,
      points: chosen.points,
    });
  }

  const benched = pool
    .filter((c) => !used.has(c.pid))
    .sort((a, b) => b.points - a.points);

  return {
    assignments,
    total: Math.round((total + Number.EPSILON) * 100) / 100,
    benched,
  };
}

/**
 * Lineup efficiency: what fraction of the optimal score a manager actually got.
 *
 * This is the single most useful "did you manage well" number in the app —
 * it separates bad luck from bad decisions.
 */
export function lineupEfficiency(actual: number, optimal: number): number {
  if (!optimal || optimal <= 0) return 0;
  return Math.round((actual / optimal) * 1000) / 1000;
}
