import type { NflState, Player } from './types';

export type NflRosterStatus = 'active' | 'practice-squad' | 'free-agent' | 'reserve' | 'suspended' | 'inactive' | 'retired' | 'unknown';
export type HealthStatus = 'out' | 'doubtful' | 'questionable' | 'unreported';

export const ROSTER_LABELS: Record<NflRosterStatus, string> = {
  active: 'Active roster', 'practice-squad': 'Practice squad', 'free-agent': 'NFL free agent',
  reserve: 'Reserve / injured list', suspended: 'Suspended / exempt', inactive: 'Inactive',
  retired: 'Retired', unknown: 'Roster status unknown',
};

const normalize = (value: string | null | undefined) => (value ?? '').trim().toUpperCase().replace(/[_-]+/g, ' ');

export function rosterStatus(player: Player | undefined): NflRosterStatus {
  if (!player) return 'unknown';
  const status = normalize(player.nflRoster?.status ?? player.status);
  const suspended = [player.injury_status, player.currentInjury?.status]
    .some((value) => ['SUSP', 'SUSPENDED', 'SUSPENSION'].includes(normalize(value)));
  if (['DEV', 'PS', 'PRACTICE SQUAD'].includes(status)) return 'practice-squad';
  if (['RET', 'RETIRED'].includes(status)) return 'retired';
  if (['SUS', 'SUSP', 'SUSPENDED', 'EXE', 'EXEMPT'].includes(status) || suspended) return 'suspended';
  if (['RES', 'IR', 'INJURED RESERVE', 'PUP', 'PHYSICALLY UNABLE TO PERFORM', 'NFI', 'NON FOOTBALL INJURY', 'RSN'].includes(status)) return 'reserve';
  if (['UFA', 'RFA', 'CUT', 'TRC', 'TRD', 'TRT', 'NWT', 'RSR', 'FREE AGENT'].includes(status)) return 'free-agent';
  // Sleeper keeps teamless players marked Active, sometimes for years.
  const team = player.nflRoster?.team ?? player.team;
  if (team === null || team === '' || normalize(team) === 'FA') return 'free-agent';
  if (['INA', 'INACTIVE'].includes(status) || (!player.nflRoster && player.active === false)) return 'inactive';
  if (team && ['ACT', 'ACTIVE'].includes(status)) return 'active';
  return 'unknown';
}

export function healthStatus(player: Player | undefined): HealthStatus {
  const statuses = [player?.injury_status, player?.currentInjury?.status].map(normalize);
  if (statuses.some((status) => ['OUT', 'IR', 'INJURED RESERVE', 'PUP', 'PHYSICALLY UNABLE TO PERFORM', 'NFI', 'NON FOOTBALL INJURY', 'COVID', 'DNR'].includes(status))) return 'out';
  if (statuses.some((status) => ['D', 'DOUBTFUL'].includes(status))) return 'doubtful';
  if (statuses.some((status) => ['Q', 'QUESTIONABLE'].includes(status))) return 'questionable';
  return 'unreported';
}

export function unavailableNow(player: Player | undefined): boolean {
  const roster = rosterStatus(player);
  return !['active', 'unknown'].includes(roster) || healthStatus(player) === 'out';
}

/** Today's status must never erase an earlier week's results or projections. */
export function usesCurrentAvailability(state: NflState | undefined, season: string, week: number): boolean {
  return state?.season === season && state.season_type === 'regular' && week === Math.max(1, state.week);
}

/** Policy discounts, not probabilities or medically estimated recovery times. */
export function availabilityFactors(player: Player | undefined): { season: number; dynasty: number } {
  const roster = rosterStatus(player);
  const rosterFactors: Record<NflRosterStatus, [number, number]> = {
    active: [1, 1], unknown: [1, 1], 'practice-squad': [0.15, 0.55],
    'free-agent': [0.1, 0.5], reserve: [0.45, 0.9], suspended: [0.4, 0.85],
    inactive: [0.2, 0.6], retired: [0, 0],
  };
  const healthFactors: Record<HealthStatus, [number, number]> = {
    unreported: [1, 1], questionable: [0.95, 0.99], doubtful: [0.8, 0.97], out: [0.65, 0.95],
  };
  const [season, dynasty] = rosterFactors[roster];
  const [healthSeason, healthDynasty] = healthFactors[healthStatus(player)];
  const window = player?.currentInjury;
  if (window && window.gamesBeforeReturn !== null && window.gamesBeforeReturn > 0 && window.remainingGames > 0
    && ['active', 'reserve', 'unknown'].includes(roster) && (roster === 'reserve' || healthStatus(player) !== 'unreported')) {
    const lostShare = window.gamesBeforeReturn / window.remainingGames;
    return { season: 1 - lostShare, dynasty: Math.min(dynasty, 1 - 0.15 * lostShare) };
  }
  // IR and Out often describe the same absence: don't compound the discounts.
  return { season: Math.min(season, healthSeason), dynasty: Math.min(dynasty, healthDynasty) };
}

export function availabilityAdjustedValue(player: Player | undefined, season: number | null, dynasty: number | null): number | null {
  const factors = availabilityFactors(player);
  const values = [season === null ? null : season * factors.season, dynasty === null ? null : dynasty * factors.dynasty]
    .filter((value): value is number => value !== null);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}
