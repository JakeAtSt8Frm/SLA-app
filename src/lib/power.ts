/**
 * Forward-looking roster power.
 *
 * Power is the custom-scored PPG of a team's best legal projected lineup. The
 * lineup is solved against Sleeper's real slots, so a player can only count
 * once and flex/superflex decisions are made as a single assignment problem.
 *
 * Bench quality is reported separately as the average projected drop when one
 * starter is unavailable. It does not receive an arbitrary bonus in the
 * headline score: two teams with the same starting projection can be compared
 * on resilience without letting a guessed depth weight reorder stronger
 * lineups.
 */

import { startingDepthByGroup } from './dynasty';
import {
  computeOptimalLineup,
  slotAccepts,
  starterSlots,
  type LineupCandidate,
  type OptimalLineup,
} from './optimal';
import { mean } from './stats';
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
  /** Projected lineup loss if this starter alone is unavailable. */
  absenceDrop: number;
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
  /** Mean projected lineup loss when one starter in this group is unavailable. */
  depthDrop: number;
  /** Alias of starterScore used to rank a positional scope. */
  score: number;
}

export interface TeamPower {
  rosterId: number;
  /** Projected PPG of the team's best legal starting lineup. */
  overall: number;
  /** Mean projected lineup loss when one starter is unavailable. */
  depthDrop: number;
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
    depthDrop: 0,
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
      .map((entry, index) => ({ ...entry, rank: index + 1, absenceDrop: 0 }));
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
        absenceDrop: 0,
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

    const absenceDropByPid = new Map<string, number>();
    for (const pid of starterIds) {
      const fallback = solve(slots, candidates.filter((candidate) => candidate.pid !== pid));
      absenceDropByPid.set(pid, Math.max(0, optimal.total - fallback.total));
    }

    const byGroup = {} as Record<PositionGroup, PowerGroup>;
    for (const group of POSITION_GROUPS) {
      byGroup[group] = emptyGroup(group, slotsByGroup.get(group) ?? 0);
    }

    for (const assignment of optimal.assignments) {
      if (isRealPlayer(assignment.pid)) {
        const player = playerByPid.get(assignment.pid);
        const group = players.get(assignment.pid)?.group;
        if (!player || !group) continue;
        const starter = {
          ...player,
          absenceDrop: absenceDropByPid.get(player.pid) ?? 0,
        };
        byGroup[group].starters.push(starter);
        byGroup[group].starterScore += starter.projectedPpg;
        byGroup[group].score += starter.projectedPpg;
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
      byGroup[group].depthDrop = mean(
        byGroup[group].starters.map((player) => player.absenceDrop),
      );
    }

    byTeam.set(roster.rosterId, {
      rosterId: roster.rosterId,
      overall: optimal.total,
      depthDrop: mean([...starterIds].map((pid) => absenceDropByPid.get(pid) ?? 0)),
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
