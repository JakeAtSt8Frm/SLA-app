/**
 * Roster power: how much a team's roster is worth, per week, above a
 * replacement-level roster.
 *
 * The obvious way to rank rosters is to average the Value Scores on them, and
 * that is what this used to do. It reads well and it is wrong, for three
 * reasons that compound:
 *
 *  - **Value Score is a percentile within a position, so the top of every pool
 *    is compressed.** In 2026 the six best tight ends in the league sit inside a
 *    21-point band on a 1000-point scale (855, 852, 841, 835, 834, 783) while
 *    their actual projected production spans 16.5 down to 8.5 points a game. A
 *    metric built on percentiles genuinely cannot tell the best tight end in the
 *    league from the fifth best.
 *  - **It ignored how many of each position you start.** This league starts one
 *    tight end and four linebackers. Averaging a team's tight ends let a third
 *    and fourth tight end — players who will never enter a lineup — outvote
 *    which team owns the best one.
 *  - **It had no notion of scarcity.** Twelve points a game from a quarterback
 *    in a superflex league and twelve from a kicker are not the same asset, but
 *    two percentiles of 90 look identical.
 *
 * So power is measured in points instead: each player's VORP — his blended
 * projection minus the production of the player at his position's startable
 * cliff, both in this league's custom scoring — summed over the slots the league
 * actually starts. That fixes all three at once. Points are comparable across
 * positions, so scarcity is intrinsic rather than a multiplier bolted on: a
 * superflex quarterback carries two slots and a wide VORP spread and therefore
 * dominates, while a kicker carries one slot over a nearly flat pool and barely
 * registers.
 *
 * The resulting number has a plain meaning: **expected points per week above a
 * roster of replacement-level starters.**
 */

import { startingDepthByGroup } from './dynasty';
import { POSITION_GROUPS, type PositionGroup } from './types';

/**
 * Weight on the best bench player at a position, decaying for each one behind
 * him. Depth is insurance, not production — it only pays out on an injury or a
 * bye — so it is a premium on top of the starters, never a substitute for them.
 */
export const DEPTH_WEIGHT = 0.25;
export const DEPTH_DECAY = 0.45;

/**
 * How much of a below-replacement starter's deficit actually lands.
 *
 * A starter worse than replacement is a real hole, but a partly fixable one —
 * the waiver wire, a streamer or a trade recovers some of it — so the deficit
 * counts at a discount rather than in full. Discounting rather than flooring at
 * zero is deliberate: flooring would rank a team with no startable tight end
 * exactly level with one whose tight end is precisely replacement level, and
 * would make an *empty* slot look as good as a filled one.
 */
export const BELOW_REPLACEMENT_DISCOUNT = 0.35;

export interface PowerPlayer {
  pid: string;
  /** Points per week above this position's replacement level. */
  vorp: number;
  /** Rank within the position among all rostered players, 1 = best. */
  rank: number;
  /** Headline Value Score, carried for display. */
  value: number | null;
}

export interface PowerGroup {
  group: PositionGroup;
  /** Starting slots at this position per team, from the league's own lineup. */
  slots: number;
  starters: PowerPlayer[];
  depth: PowerPlayer[];
  /** Slots this team cannot fill from its own roster. */
  unfilledSlots: number;
  /** Points/week above replacement from the slots this position starts. */
  starterScore: number;
  /** Discounted insurance value of everyone behind the starters. */
  depthScore: number;
  score: number;
}

export interface TeamPower {
  rosterId: number;
  /** Points/week above a replacement-level roster, summed over every position. */
  overall: number;
  byGroup: Record<PositionGroup, PowerGroup>;
}

export interface PowerRosterInput {
  rosterId: number;
  /**
   * Every player the team holds — starters, bench, taxi and reserve.
   *
   * Sleeper lists an injured player in both `players` and `reserve`, so ids are
   * de-duplicated here rather than trusted: counting a quarterback twice would
   * let him fill both superflex slots by himself.
   */
  playerIds: Iterable<string>;
}

export interface PowerPlayerInput {
  group: PositionGroup;
  /** Null when the player has no usable production or forecast. */
  vorp: number | null;
  value: number | null;
}

export interface BuildPowerIndexInput {
  rosters: PowerRosterInput[];
  players: Map<string, PowerPlayerInput>;
  rosterPositions: string[];
  numTeams: number;
}

export interface PowerIndex {
  byTeam: Map<number, TeamPower>;
  /** Starting slots per team, per position. */
  slotsByGroup: Map<PositionGroup, number>;
  /** Rostered players at each position, best VORP first — the rank ladder. */
  ladderByGroup: Map<PositionGroup, PowerPlayer[]>;
}

function emptyGroup(group: PositionGroup, slots: number): PowerGroup {
  return {
    group,
    slots,
    starters: [],
    depth: [],
    unfilledSlots: slots,
    starterScore: 0,
    depthScore: 0,
    score: 0,
  };
}

/**
 * Contribution of one starting slot.
 *
 * `share` is below 1 only for the fractional tail of a flex slot — a FLEX that
 * is filled by a running back 35% of the time contributes 0.35 of a slot to the
 * running back pool.
 */
function starterContribution(vorp: number, share: number): number {
  const scaled = vorp >= 0 ? vorp : vorp * BELOW_REPLACEMENT_DISCOUNT;
  return scaled * share;
}

export function buildPowerIndex(input: BuildPowerIndexInput): PowerIndex {
  const { players, rosterPositions, numTeams } = input;
  const rosters = input.rosters.map((roster) => ({
    rosterId: roster.rosterId,
    playerIds: [...new Set(roster.playerIds)],
  }));

  // The league's own lineup decides how many of each position matters. The
  // dynasty model already resolves flex slots into fractional positional depth
  // across the league; dividing by the team count gives slots per team.
  const leagueDepth = startingDepthByGroup(rosterPositions, numTeams);
  const slotsByGroup = new Map<PositionGroup, number>();
  for (const group of POSITION_GROUPS) {
    slotsByGroup.set(group, numTeams > 0 ? (leagueDepth.get(group) ?? 0) / numTeams : 0);
  }

  // One league-wide ladder per position, so "TE #1" means the same thing on
  // every team's row.
  const rostered = new Map<PositionGroup, Array<{ pid: string; vorp: number; value: number | null }>>();
  for (const roster of rosters) {
    for (const pid of roster.playerIds) {
      const player = players.get(pid);
      if (!player) continue;
      const bucket = rostered.get(player.group) ?? [];
      bucket.push({ pid, vorp: player.vorp ?? 0, value: player.value });
      rostered.set(player.group, bucket);
    }
  }

  const ladderByGroup = new Map<PositionGroup, PowerPlayer[]>();
  const rankByPid = new Map<string, number>();
  for (const [group, bucket] of rostered) {
    const ladder = bucket
      .sort((a, b) => b.vorp - a.vorp)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    for (const entry of ladder) rankByPid.set(entry.pid, entry.rank);
    ladderByGroup.set(group, ladder);
  }

  // What an unfilled slot is worth: whoever is left unrostered. The worst player
  // anyone bothered to keep is the closest observable stand-in for the best of
  // what remains on waivers, and it is always at or below the startable cliff.
  const waiverVorpByGroup = new Map<PositionGroup, number>();
  for (const [group, ladder] of ladderByGroup) {
    waiverVorpByGroup.set(group, Math.min(0, ladder[ladder.length - 1]?.vorp ?? 0));
  }

  const byTeam = new Map<number, TeamPower>();

  for (const roster of rosters) {
    const byPosition = new Map<PositionGroup, PowerPlayer[]>();
    for (const pid of roster.playerIds) {
      const player = players.get(pid);
      if (!player) continue;
      const entry: PowerPlayer = {
        pid,
        vorp: player.vorp ?? 0,
        value: player.value,
        rank: rankByPid.get(pid) ?? 0,
      };
      const bucket = byPosition.get(player.group);
      if (bucket) bucket.push(entry);
      else byPosition.set(player.group, [entry]);
    }

    const byGroup = {} as Record<PositionGroup, PowerGroup>;
    let overall = 0;

    for (const group of POSITION_GROUPS) {
      const slots = slotsByGroup.get(group) ?? 0;
      const held = (byPosition.get(group) ?? []).sort((a, b) => b.vorp - a.vorp);
      if (slots <= 0 && held.length === 0) {
        byGroup[group] = emptyGroup(group, slots);
        continue;
      }

      const starters: PowerPlayer[] = [];
      const depth: PowerPlayer[] = [];
      let starterScore = 0;
      let remaining = slots;

      for (const player of held) {
        if (remaining <= 0) {
          depth.push(player);
          continue;
        }
        const share = Math.min(1, remaining);
        starterScore += starterContribution(player.vorp, share);
        starters.push(player);
        remaining -= share;
      }

      // An unfilled slot is not free. Leaving it empty means starting whoever is
      // left on the waiver wire, which by construction sits below the startable
      // cliff, so it is charged at the same discounted rate a below-replacement
      // starter is — otherwise a team short a linebacker would outrank one that
      // at least rosters a weak fourth.
      const unfilledSlots = Math.max(0, remaining);
      if (unfilledSlots > 0) {
        starterScore += starterContribution(
          waiverVorpByGroup.get(group) ?? 0,
          unfilledSlots,
        );
      }

      let depthScore = 0;
      let weight = DEPTH_WEIGHT;
      for (const player of depth) {
        if (player.vorp > 0) depthScore += player.vorp * weight;
        weight *= DEPTH_DECAY;
      }

      const score = starterScore + depthScore;
      byGroup[group] = {
        group,
        slots,
        starters,
        depth,
        unfilledSlots,
        starterScore,
        depthScore,
        score,
      };
      overall += score;
    }

    byTeam.set(roster.rosterId, { rosterId: roster.rosterId, overall, byGroup });
  }

  return { byTeam, slotsByGroup, ladderByGroup };
}

/** Scales scores so the strongest roster reads 100 and the rest sit in proportion. */
export function powerIndexOf(score: number, best: number): number {
  if (!Number.isFinite(score) || best <= 0) return score > 0 ? 100 : 0;
  return Math.max(0, (score / best) * 100);
}
