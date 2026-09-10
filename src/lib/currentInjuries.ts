import type { Player } from './types';

export interface CurrentInjurySnapshot {
  season: string;
  asOf: string;
  players: Record<string, { status: string; injury: string; returnDate: string | null; reportedAt: string }>;
  schedule: Array<{ home: string; away: string; date: string }>;
}

export function returnWindow(team: string | null | undefined, returnDate: string | null,
  schedule: CurrentInjurySnapshot['schedule'], today: string): { gamesBeforeReturn: number | null; remainingGames: number } {
  const remaining = schedule.filter((game) => (game.home === team || game.away === team) && game.date >= today);
  return {
    remainingGames: remaining.length,
    gamesBeforeReturn: returnDate && returnDate >= today && remaining.length
      ? remaining.filter((game) => game.date < returnDate).length : null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseCurrentInjuries(value: unknown, season: string, now = Date.now()): CurrentInjurySnapshot | null {
  if (!record(value) || value.season !== season || typeof value.asOf !== 'string' || !record(value.players) || !Array.isArray(value.schedule)) return null;
  const age = now - Date.parse(value.asOf);
  if (!Number.isFinite(age) || age < -86_400_000 || age > 3 * 86_400_000) return null;
  const players: CurrentInjurySnapshot['players'] = {};
  for (const [id, row] of Object.entries(value.players)) {
    if (!/^\d+$/.test(id) || !record(row) || typeof row.status !== 'string' || typeof row.injury !== 'string'
      || typeof row.reportedAt !== 'string' || !Number.isFinite(Date.parse(row.reportedAt))
      || !(row.returnDate === null || (typeof row.returnDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.returnDate) && Number.isFinite(Date.parse(row.returnDate))))) return null;
    players[id] = { status: row.status, injury: row.injury, returnDate: row.returnDate as string | null, reportedAt: row.reportedAt };
  }
  const schedule: CurrentInjurySnapshot['schedule'] = [];
  for (const game of value.schedule) {
    if (!record(game) || typeof game.home !== 'string' || typeof game.away !== 'string'
      || typeof game.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(game.date)) return null;
    schedule.push({ home: game.home, away: game.away, date: game.date });
  }
  return { season, asOf: value.asOf, players, schedule };
}

export async function getCurrentInjuries(season: string, signal?: AbortSignal): Promise<CurrentInjurySnapshot | null> {
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetch(`${import.meta.env.BASE_URL}data/current-injuries.json`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return response.ok ? parseCurrentInjuries(await response.json(), season) : null;
  } catch { return null; }
}

export function applyCurrentInjuries(players: Map<string, Player>, snapshot: CurrentInjurySnapshot | null, now = Date.now()): void {
  if (!snapshot) return;
  const today = new Date(now).toISOString().slice(0, 10);
  for (const [pid, player] of players) {
    const injury = player.espn_id == null ? undefined : snapshot.players[String(player.espn_id)];
    if (!injury) continue;
    players.set(pid, { ...player, currentInjury: {
      ...injury, asOf: snapshot.asOf,
      ...returnWindow(player.nflRoster?.team ?? player.team, injury.returnDate, snapshot.schedule, today),
    } });
  }
}
