import { groupForPlayer, hasPlayed } from './scoring';
import type { Player, StatLine } from './types';

interface MetricWeek {
  stats: Record<string, StatLine>;
  teams: Record<string, string>;
}

export interface PlayerMetric {
  label: string;
  value: number | null;
  unit: 'number' | 'percent';
  detail: string;
}

/** Rates use summed numerators and denominators, not averages of weekly ratios. */
export function playerMetrics(pid: string, player: Player, weeks: Map<number, MetricWeek>, throughWeek: number): { games: number; metrics: PlayerMetric[] } {
  const lines: StatLine[] = [];
  const teammates: StatLine[] = [];
  let hasAllTeamAssignments = true;
  for (const [week, payload] of weeks) {
    const line = payload.stats[pid];
    if (week > throughWeek || !hasPlayed(line)) continue;
    lines.push(line);
    const team = payload.teams[pid];
    if (!team) hasAllTeamAssignments = false;
    // A traded player's denominator follows his team in each observed week.
    if (team) for (const [otherPid, other] of Object.entries(payload.stats)) {
      if (/^\d+$/.test(otherPid) && payload.teams[otherPid] === team) teammates.push(other);
    }
  }
  const sum = (rows: StatLine[], key: string): number | null => {
    const values = rows.flatMap((row) => typeof row[key] === 'number' && Number.isFinite(row[key]) ? [row[key] as number] : []);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const ratio = (numerator: number | null, denominator: number | null, scale = 1): number | null =>
    numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator * scale : null;
  const own = (key: string) => sum(lines, key);
  const team = (key: string) => hasAllTeamAssignments ? sum(teammates, key) : null;
  const metrics: PlayerMetric[] = [];
  const add = (label: string, value: number | null, detail: string, unit: PlayerMetric['unit'] = 'number') => metrics.push({ label, value, detail, unit });
  const perGame = (label: string, key: string) => add(label, ratio(own(key), lines.length), `Per game with recorded participation; ${key}`);
  const targetShare = ratio(own('rec_tgt'), team('rec_tgt'));
  const airShare = ratio(own('rec_air_yd'), team('rec_air_yd'));
  const group = groupForPlayer(player);

  if (group === 'QB') {
    perGame('Pass attempts / game', 'pass_att');
    perGame('Rush attempts / game', 'rush_att');
    add('Completion rate', ratio(own('pass_cmp'), own('pass_att'), 100), 'Completions / pass attempts', 'percent');
    add('Passing yards / attempt', ratio(own('pass_yd'), own('pass_att')), 'Passing yards / attempts');
    const attempts = own('pass_att');
    const sacks = own('pass_sack');
    add('Sack rate', ratio(sacks, attempts !== null && sacks !== null ? attempts + sacks : null, 100), 'Sacks / (attempts + sacks); excludes scrambles', 'percent');
    perGame('Red-zone pass attempts', 'pass_rz_att');
    perGame('Red-zone carries', 'rush_rz_att');
  } else if (group === 'RB' || group === 'WR' || group === 'TE') {
    perGame('Targets / game', 'rec_tgt');
    if (group === 'RB') {
      perGame('Carries / game', 'rush_att');
      add('Team carry share', ratio(own('rush_att'), team('rush_att'), 100), 'Share of all team carries in the player’s observed games', 'percent');
      perGame('Red-zone carries', 'rush_rz_att');
    }
    add('Team target share', targetShare === null ? null : targetShare * 100, 'Share of all team receiving targets, across every position, in observed games', 'percent');
    add('Air-yard share', airShare === null ? null : airShare * 100, 'Receiving air yards / team receiving air yards in observed games', 'percent');
    add('aDOT', ratio(own('rec_air_yd'), own('rec_tgt')), 'Receiving air yards / targets');
    add('WOPR', targetShare !== null && airShare !== null ? 1.5 * targetShare + 0.7 * airShare : null, '1.5 × target share + 0.7 × air-yard share; not bounded to 1');
    add('Yards / target', ratio(own('rec_yd'), own('rec_tgt')), 'Receiving yards / targets; not yards per route run');
    perGame('Red-zone targets', 'rec_rz_tgt');
  } else if (group === 'DL' || group === 'LB' || group === 'DB') {
    perGame('Solo tackles / game', 'idp_tkl_solo');
    perGame('Assists / game', 'idp_tkl_ast');
    perGame('Sacks / game', 'idp_sack');
    perGame('QB hits / game', 'idp_qb_hit');
    perGame('Passes defended / game', 'idp_pass_def');
  } else if (group === 'K') {
    perGame('FG attempts / game', 'fga');
    perGame('XP attempts / game', 'xpa');
    add('FG accuracy', ratio(own('fgm'), own('fga'), 100), 'Field goals made / attempted', 'percent');
  }
  return { games: lines.length, metrics };
}
