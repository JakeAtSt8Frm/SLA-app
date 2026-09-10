import type { Player } from './types';

export interface RosterSnapshot {
  season: string;
  asOf: string;
  players: Record<string, { status: string; team: string; week: number }>;
}

export interface InjuryReport {
  season: number;
  week: number;
  injury: string;
  status: string;
}

export interface InjuryHistory {
  seasons: number[];
  players: Record<string, InjuryReport[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRosterSnapshot(value: unknown, season: string, now = Date.now()): RosterSnapshot | null {
  if (!isRecord(value) || value.season !== season || typeof value.asOf !== 'string' || !isRecord(value.players)) return null;
  const age = now - Date.parse(value.asOf);
  if (!Number.isFinite(age) || age < -86_400_000 || age > 3 * 86_400_000) return null;
  const players: RosterSnapshot['players'] = {};
  for (const [pid, row] of Object.entries(value.players)) {
    if (!/^\d+$/.test(pid) || !isRecord(row) || typeof row.status !== 'string' || typeof row.team !== 'string'
      || typeof row.week !== 'number' || !Number.isInteger(row.week) || row.week < 0 || row.week > 22) return null;
    players[pid] = { status: row.status, team: row.team, week: row.week };
  }
  return Object.keys(players).length ? { season, asOf: value.asOf, players } : null;
}

export async function getRosterSnapshot(season: string, signal?: AbortSignal): Promise<RosterSnapshot | null> {
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetch(`${import.meta.env.BASE_URL}data/nfl-rosters.json`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return response.ok ? parseRosterSnapshot(await response.json(), season) : null;
  } catch {
    return null;
  }
}

export function applyRosterSnapshot(players: Map<string, Player>, snapshot: RosterSnapshot | null): void {
  if (!snapshot) return;
  for (const [pid, row] of Object.entries(snapshot.players)) {
    const player = players.get(pid);
    if (player) players.set(pid, { ...player, nflRoster: { ...row, asOf: snapshot.asOf } });
  }
}

/** Loaded only when a player sheet is opened. No medical history on the startup path. */
let historyRequest: Promise<InjuryHistory | null> | undefined;
export function getInjuryHistory(): Promise<InjuryHistory | null> {
  return historyRequest ??= fetch(`${import.meta.env.BASE_URL}data/injury-history.json`, { signal: AbortSignal.timeout(10_000) })
    .then(async (response): Promise<InjuryHistory | null> => {
      if (!response.ok) return null;
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.seasons) || !value.seasons.every((s) => Number.isInteger(s)) || !isRecord(value.players)) return null;
      const players: InjuryHistory['players'] = {};
      for (const [pid, reports] of Object.entries(value.players)) {
        if (!Array.isArray(reports)) return null;
        const valid: InjuryReport[] = [];
        for (const row of reports) {
          if (!isRecord(row) || typeof row.season !== 'number' || typeof row.week !== 'number'
            || typeof row.injury !== 'string' || typeof row.status !== 'string') return null;
          valid.push({ season: row.season, week: row.week, injury: row.injury, status: row.status });
        }
        players[pid] = valid;
      }
      return { seasons: value.seasons as number[], players };
    }).catch(() => null);
}
