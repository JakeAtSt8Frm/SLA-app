/**
 * Selectors that turn raw league data into the view models the pages render.
 *
 * Keeping this separate from the components means the same enriched shape backs
 * the roster page, the matchup view, history and the trade analyser — so a
 * player's Value Score and boom/bust classification can never disagree between
 * two screens.
 */

import { groupForPlayer, hasPlayed } from '../lib/scoring';
import { classifyStatus } from '../lib/status';
import { computeOptimalLineup, lineupEfficiency, slotAccepts } from '../lib/optimal';
import type { EnrichedPlayer, PositionGroup, StatLine } from '../lib/types';
import { isOut, playerName, type LeagueData, type TeamInfo } from './league';

/** Bench-type slots, in priority order when a player appears in several lists. */
const BENCH_PRIORITY: Record<string, number> = { IR: 3, TX: 2, BN: 1 };

export interface RosterWeek {
  team: TeamInfo;
  week: number;
  starters: EnrichedPlayer[];
  bench: EnrichedPlayer[];
  injured: EnrichedPlayer[];
  all: EnrichedPlayer[];
  projectedTotal: number;
  actualTotal: number;
  optimalTotal: number;
  efficiency: number;
  optimalLineup: ReturnType<typeof computeOptimalLineup>;
}

/**
 * Enriches one player for one week with everything the UI needs.
 */
export function enrichPlayer(
  data: LeagueData,
  pid: string,
  week: number,
  slot: string,
  isStarter: boolean,
): EnrichedPlayer {
  const weekData = data.weeks.get(week);
  const statLine: StatLine | undefined = weekData?.stats[pid];
  const projLine: StatLine | undefined = weekData?.projections[pid];
  const opponent = weekData?.opponents[pid] ?? null;

  const player = data.playersById.get(pid);
  const group = groupForPlayer(player);

  const proj = data.score(projLine);
  const act = data.score(statLine);
  const played = hasPlayed(statLine);

  const matchup = data.matchupIndex.get(group, opponent);
  const matchupScore = matchup?.score ?? null;

  return {
    pid,
    player: player ?? { player_id: pid },
    name: playerName(player, pid),
    team: (player?.team ?? '').toUpperCase(),
    group,
    slot,
    isStarter,
    proj,
    act,
    hasPlayed: played,
    status: classifyStatus(proj, act, played, matchupScore),
    opponent,
    /*
     * Sleeper reports a player's injury status as of *now*, not as of the week
     * being viewed. Applying it verbatim to a past week produced nonsense —
     * a player who scored 25 points in week 17 showing up under "Injured /
     * Out" because he happens to be on IR today. If he recorded stats that
     * week, he plainly was not out.
     */
    isOut: isOut(player) && !played,
    seasonTotal: data.valueIndex.seasonTotals.get(pid) ?? 0,
    valueScore: data.valueIndex.byPlayer.get(pid)?.score ?? null,
    matchupScore,
    ppgRank: data.valueIndex.ppgRanks.get(pid) ?? null,
    totalRank: data.valueIndex.totalRanks.get(pid) ?? null,
  };
}

/**
 * Builds the full view of one team's week.
 *
 * Starters come from the week's matchup record rather than the roster, because
 * the roster reflects *today's* lineup while the matchup records who actually
 * started that week — the distinction is the entire point of the history page.
 */
export function buildRosterWeek(
  data: LeagueData,
  rosterId: number,
  week: number,
): RosterWeek | null {
  const team = data.teamsById.get(rosterId);
  if (!team) return null;

  const weekData = data.weeks.get(week);
  const matchup = weekData?.matchups.find((m) => m.roster_id === rosterId);

  const clean = (ids: (string | null | undefined)[] | null | undefined) =>
    (ids ?? []).map((x) => String(x ?? '')).filter((x) => x && x !== '0');

  /*
   * Normally the matchup record wins: it captures who actually started that
   * week, whereas the roster reflects today's lineup — the distinction is the
   * whole point of the history page.
   *
   * When rosters are overridden to another season, that must not happen. The
   * matchup belongs to the scoring season, so using it would quietly show that
   * season's lineup instead of the roster the user asked for.
   */
  const useMatchupLineup = !data.rostersOverridden;

  const starterIds = clean(
    useMatchupLineup ? (matchup?.starters ?? team.roster.starters) : team.roster.starters,
  );
  const allIds = clean(
    useMatchupLineup ? (matchup?.players ?? team.roster.players) : team.roster.players,
  );

  const slots = data.starterSlots;
  const starterSet = new Set(starterIds);

  const starters = starterIds.map((pid, i) =>
    enrichPlayer(data, pid, week, slots[i] ?? 'ST', true),
  );

  // Bench, taxi and IR all live in separate arrays that can overlap; de-dupe
  // keeping the most specific designation.
  const benchSlots = new Map<string, string>();
  const addBench = (pid: string, slot: string) => {
    if (!pid || starterSet.has(pid)) return;
    const existing = benchSlots.get(pid);
    if (!existing || (BENCH_PRIORITY[slot] ?? 0) > (BENCH_PRIORITY[existing] ?? 0)) {
      benchSlots.set(pid, slot);
    }
  };

  for (const pid of allIds) addBench(pid, 'BN');
  for (const pid of clean(team.roster.taxi)) addBench(pid, 'TX');
  for (const pid of clean(team.roster.reserve)) addBench(pid, 'IR');

  const benchAll = [...benchSlots].map(([pid, slot]) => enrichPlayer(data, pid, week, slot, false));
  const bench = benchAll.filter((p) => !p.isOut);
  const injured = benchAll.filter((p) => p.isOut);

  const projectedTotal = round2(starters.reduce((s, p) => s + p.proj, 0));
  const actualTotal = round2(starters.reduce((s, p) => s + p.act, 0));

  // The optimal lineup considers everyone who was on the roster that week.
  const pool = [...starters, ...benchAll].map((p) => ({
    pid: p.pid,
    group: p.group,
    points: p.act,
  }));
  const optimalLineup = computeOptimalLineup(slots, pool);

  return {
    team,
    week,
    starters,
    bench: bench.sort(sortByImpact),
    injured,
    all: [...starters, ...benchAll],
    projectedTotal,
    actualTotal,
    optimalTotal: optimalLineup.total,
    efficiency: lineupEfficiency(actualTotal, optimalLineup.total),
    optimalLineup,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Bench ordering: whoever most deserved a start appears first. */
function sortByImpact(a: EnrichedPlayer, b: EnrichedPlayer): number {
  return b.act - a.act || b.proj - a.proj || (b.valueScore ?? 0) - (a.valueScore ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Heatmap data                                                                */
/* -------------------------------------------------------------------------- */

export const HEATMAP_GROUPS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];

export interface HeatmapRow {
  rosterId: number;
  name: string;
  byGroup: Record<PositionGroup, number>;
  total: number;
}

export type HeatmapScope = 'starters' | 'all';
export type HeatmapMetric = 'projected' | 'actual';

/**
 * Builds one heatmap: a team x position-group grid of custom-scored points.
 *
 * This is the view that makes positional strength legible at a glance — with
 * seven of twenty-one starting slots being IDP in this league, "who is deep at
 * linebacker" is a real strategic question that a flat roster list hides.
 */
export function buildHeatmap(
  data: LeagueData,
  week: number,
  scope: HeatmapScope,
  metric: HeatmapMetric,
): HeatmapRow[] {
  const weekData = data.weeks.get(week);

  return data.teams.map((team) => {
    const matchup = data.rostersOverridden
      ? undefined
      : weekData?.matchups.find((m) => m.roster_id === team.rosterId);

    const ids = (
      scope === 'starters'
        ? (matchup?.starters ?? team.roster.starters ?? [])
        : (matchup?.players ?? team.roster.players ?? [])
    )
      .map((x) => String(x ?? ''))
      .filter((x) => x && x !== '0');

    const byGroup = Object.fromEntries(
      HEATMAP_GROUPS.map((g) => [g, 0]),
    ) as Record<PositionGroup, number>;

    for (const pid of ids) {
      const group = groupForPlayer(data.playersById.get(pid));
      if (!group) continue;
      const line =
        metric === 'actual' ? weekData?.stats[pid] : weekData?.projections[pid];
      byGroup[group] += data.score(line);
    }

    let total = 0;
    for (const g of HEATMAP_GROUPS) {
      byGroup[g] = round2(byGroup[g]);
      total += byGroup[g];
    }

    return { rosterId: team.rosterId, name: team.name, byGroup, total: round2(total) };
  });
}

/* -------------------------------------------------------------------------- */
/* Free agents                                                                 */
/* -------------------------------------------------------------------------- */

/** Every player id currently rostered by anybody in the league. */
export function rosteredIds(data: LeagueData): Set<string> {
  const owned = new Set<string>();
  for (const team of data.teams) {
    for (const pid of team.roster.players ?? []) if (pid) owned.add(String(pid));
    for (const pid of team.roster.taxi ?? []) if (pid) owned.add(String(pid));
    for (const pid of team.roster.reserve ?? []) if (pid) owned.add(String(pid));
  }
  return owned;
}

/**
 * Available free agents, ranked by Value Score.
 *
 * Restricted to players who have actually recorded a scoring week, since the
 * full Sleeper dictionary contains thousands of practice-squad entries that
 * would otherwise swamp the list.
 */
export function freeAgents(data: LeagueData, group: PositionGroup | 'ALL'): EnrichedPlayer[] {
  const owned = rosteredIds(data);
  const out: EnrichedPlayer[] = [];

  for (const [pid, value] of data.valueIndex.byPlayer) {
    if (owned.has(pid)) continue;
    if (group !== 'ALL' && value.group !== group) continue;
    out.push(enrichPlayer(data, pid, data.currentWeek, value.group, false));
  }

  return out.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0));
}

/** Players on a roster that are eligible for a given slot. */
export function eligibleFor(players: EnrichedPlayer[], slot: string): EnrichedPlayer[] {
  return players.filter((p) => slotAccepts(slot, p.group));
}
