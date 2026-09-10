import { hasPlayed } from './scoring';
import type { StatLine } from './types';

interface TeamWeek { stats: Record<string, StatLine>; teams: Record<string, string> }
export interface TeamStats {
  games: number;
  passYards: number | null;
  rushYards: number | null;
  passAttempts: number | null;
  rushAttempts: number | null;
  sacksTaken: number | null;
}

/** Pregame team rates from historical player-team assignments. No live roster fallback. */
export function buildTeamStats(weeks: Map<number, TeamWeek>, beforeWeek: number): Map<string, TeamStats> {
  const totals = new Map<string, { weeks: Set<number>; sums: Record<string, number>; observed: Set<string> }>();
  const keys = ['pass_yd', 'rush_yd', 'pass_att', 'rush_att', 'pass_sack'];
  for (const [week, payload] of weeks) {
    if (week >= beforeWeek) continue;
    for (const [pid, line] of Object.entries(payload.stats)) {
      // Team D/ST rows can duplicate offensive aggregates in some payloads.
      if (!/^\d+$/.test(pid) || !hasPlayed(line)) continue;
      const team = payload.teams[pid];
      if (!team) continue;
      const entry = totals.get(team) ?? { weeks: new Set<number>(), sums: {}, observed: new Set<string>() };
      entry.weeks.add(week);
      for (const key of keys) {
        const value = line[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          entry.sums[key] = (entry.sums[key] ?? 0) + value;
          entry.observed.add(key);
        }
      }
      totals.set(team, entry);
    }
  }
  return new Map([...totals].map(([team, entry]) => {
    const avg = (key: string) => entry.observed.has(key) ? entry.sums[key] / entry.weeks.size : null;
    return [team, { games: entry.weeks.size, passYards: avg('pass_yd'), rushYards: avg('rush_yd'),
      passAttempts: avg('pass_att'), rushAttempts: avg('rush_att'), sacksTaken: avg('pass_sack') }];
  }));
}
