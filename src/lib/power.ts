/**
 * Forward-looking roster power.
 *
 * Overall power is the custom-scored PPG of a team's best legal projected
 * lineup. Positional power is an outlier-resistant average across the whole
 * rostered position room, so it reflects depth without letting one extreme
 * projection dominate the result.
 */

import { startingDepthByGroup } from './dynasty';
import {
  computeOptimalLineup,
  slotAccepts,
  starterSlots,
  type LineupCandidate,
  type OptimalLineup,
} from './optimal';
import { mean, quantile } from './stats';
import { POSITION_GROUPS, type PositionGroup } from './types';

const DUMMY_PREFIX = '__power_replacement__';

export interface PowerPlayer {
  pid: string;
  /** Blended custom-scored projection in points per game. */
  projectedPpg: number;
  /** Rank by projected PPG within the position, 1 = best. */
  rank: number;
  /** Headline Value Score, carried for display. */
  value: number | null;
}

export interface PowerGroup {
  group: PositionGroup;
  /** Expected starting slots per team; flex slots are split fractionally. */
  slots: number;
  starters: PowerPlayer[];
  depth: PowerPlayer[];
  /** Exact legal lineup slots that could not be filled by a projected player. */
  unfilledSlots: number;
  /** Projected PPG contributed by this position in the best legal lineup. */
  starterScore: number;
  /** Number of projections outside Tukey's 1.5× IQR fences. */
  outliersRemoved: number;
  /** Outlier-resistant average PPG across the rostered position room. */
  score: number;
}

export interface TeamPower {
  rosterId: number;
  /** Projected PPG of the team's best legal starting lineup. */
  overall: number;
  byGroup: Record<PositionGroup, PowerGroup>;
}

export interface PowerRosterInput {
  rosterId: number;
  /**
   * Every player the team holds — starters, bench, taxi and reserve.
   *
   * Sleeper may list an injured player in both `players` and `reserve`, so ids
   * are de-duplicated before the lineup is solved.
   */
  playerIds: Iterable<string>;
}

export interface PowerPlayerInput {
  group: PositionGroup;
  /** Null when no usable production history or forecast exists. */
  projectedPpg: number | null;
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
  /** Expected starting slots per team, per position. */
  slotsByGroup: Map<PositionGroup, number>;
  /** Rostered projected players at each position, best PPG first. */
  ladderByGroup: Map<PositionGroup, PowerPlayer[]>;
}

function emptyGroup(group: PositionGroup, slots: number): PowerGroup {
  return {
    group,
    slots,
    starters: [],
    depth: [],
    unfilledSlots: 0,
    starterScore: 0,
    outliersRemoved: 0,
    score: 0,
  };
}

function dummyGroupForSlot(slot: string): PositionGroup {
  return POSITION_GROUPS.find((group) => slotAccepts(slot, group)) ?? 'QB';
}

/**
 * Adds zero-point replacement candidates so the assignment solver can leave
 * any slot effectively unfilled without ever preferring an ineligible player.
 */
function withReplacementCandidates(
  slots: string[],
  candidates: LineupCandidate[],
): LineupCandidate[] {
  return [
    ...candidates,
    ...slots.map((slot, index) => ({
      pid: `${DUMMY_PREFIX}${index}`,
      group: dummyGroupForSlot(slot),
      points: 0,
    })),
  ];
}

function solve(slots: string[], candidates: LineupCandidate[]): OptimalLineup {
  return computeOptimalLineup(slots, withReplacementCandidates(slots, candidates));
}

function isRealPlayer(pid: string | null): pid is string {
  return pid !== null && !pid.startsWith(DUMMY_PREFIX);
}

/**
 * Tukey's 1.5× IQR rule is conservative for small roster rooms: it removes
 * only statistically isolated projections rather than trimming the best and
 * worst player unconditionally. Fewer than four observations are kept intact
 * because quartiles are not stable enough to label an outlier.
 */
export function outlierResistantMean(
  values: number[],
  minimumSamples = 0,
): { average: number; outliersRemoved: number } {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  let included = finite;

  if (finite.length >= 4) {
    const q1 = quantile(finite, 0.25);
    const q3 = quantile(finite, 0.75);
    const iqr = q3 - q1;
    if (iqr > 0) {
      const lowerFence = q1 - 1.5 * iqr;
      const upperFence = q3 + 1.5 * iqr;
      included = finite.filter((value) => value >= lowerFence && value <= upperFence);
    }
  }

  const padded = [...included];
  while (padded.length < Math.max(0, Math.ceil(minimumSamples))) padded.push(0);

  return {
    average: mean(padded),
    outliersRemoved: finite.length - included.length,
  };
}

export function buildPowerIndex(input: BuildPowerIndexInput): PowerIndex {
  const { players, rosterPositions, numTeams } = input;
  const rosters = input.rosters.map((roster) => ({
    rosterId: roster.rosterId,
    playerIds: [...new Set(roster.playerIds)],
  }));
  const slots = starterSlots(rosterPositions);

  const leagueDepth = startingDepthByGroup(rosterPositions, numTeams);
  const slotsByGroup = new Map<PositionGroup, number>();
  for (const group of POSITION_GROUPS) {
    slotsByGroup.set(group, numTeams > 0 ? (leagueDepth.get(group) ?? 0) / numTeams : 0);
  }

  const rostered = new Map<
    PositionGroup,
    Array<{ pid: string; projectedPpg: number; value: number | null }>
  >();
  for (const roster of rosters) {
    for (const pid of roster.playerIds) {
      const player = players.get(pid);
      if (!player || player.projectedPpg === null || !Number.isFinite(player.projectedPpg)) {
        continue;
      }
      const bucket = rostered.get(player.group) ?? [];
      bucket.push({
        pid,
        projectedPpg: Math.max(0, player.projectedPpg),
        value: player.value,
      });
      rostered.set(player.group, bucket);
    }
  }

  const ladderByGroup = new Map<PositionGroup, PowerPlayer[]>();
  const rankByPid = new Map<string, number>();
  for (const [group, bucket] of rostered) {
    const ladder = bucket
      .sort((a, b) => b.projectedPpg - a.projectedPpg || a.pid.localeCompare(b.pid))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    for (const entry of ladder) rankByPid.set(entry.pid, entry.rank);
    ladderByGroup.set(group, ladder);
  }

  const byTeam = new Map<number, TeamPower>();

  for (const roster of rosters) {
    const held = roster.playerIds.flatMap((pid): PowerPlayer[] => {
      const player = players.get(pid);
      if (!player || player.projectedPpg === null || !Number.isFinite(player.projectedPpg)) {
        return [];
      }
      return [{
        pid,
        projectedPpg: Math.max(0, player.projectedPpg),
        value: player.value,
        rank: rankByPid.get(pid) ?? 0,
      }];
    });
    const playerByPid = new Map(held.map((player) => [player.pid, player]));
    const candidates = held.map((player) => ({
      pid: player.pid,
      group: players.get(player.pid)?.group ?? null,
      points: player.projectedPpg,
    }));
    const optimal = solve(slots, candidates);
    const starterIds = new Set(optimal.assignments.map((row) => row.pid).filter(isRealPlayer));

    const byGroup = {} as Record<PositionGroup, PowerGroup>;
    for (const group of POSITION_GROUPS) {
      byGroup[group] = emptyGroup(group, slotsByGroup.get(group) ?? 0);
    }

    for (const assignment of optimal.assignments) {
      if (isRealPlayer(assignment.pid)) {
        const player = playerByPid.get(assignment.pid);
        const group = players.get(assignment.pid)?.group;
        if (!player || !group) continue;
        byGroup[group].starters.push(player);
        byGroup[group].starterScore += player.projectedPpg;
      } else {
        byGroup[dummyGroupForSlot(assignment.slot)].unfilledSlots += 1;
      }
    }

    for (const player of held) {
      if (starterIds.has(player.pid)) continue;
      const group = players.get(player.pid)?.group;
      if (group) byGroup[group].depth.push(player);
    }

    for (const group of POSITION_GROUPS) {
      byGroup[group].starters.sort(
        (a, b) => b.projectedPpg - a.projectedPpg || a.pid.localeCompare(b.pid),
      );
      byGroup[group].depth.sort(
        (a, b) => b.projectedPpg - a.projectedPpg || a.pid.localeCompare(b.pid),
      );
      const room = outlierResistantMean(
        [...byGroup[group].starters, ...byGroup[group].depth].map(
          (player) => player.projectedPpg,
        ),
        byGroup[group].slots,
      );
      byGroup[group].score = room.average;
      byGroup[group].outliersRemoved = room.outliersRemoved;
    }

    byTeam.set(roster.rosterId, {
      rosterId: roster.rosterId,
      overall: optimal.total,
      byGroup,
    });
  }

  return { byTeam, slotsByGroup, ladderByGroup };
}

/** Scales scores so the strongest projected lineup reads 100. */
export function powerIndexOf(score: number, best: number): number {
  if (!Number.isFinite(score) || best <= 0) return score > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (score / best) * 100));
}
