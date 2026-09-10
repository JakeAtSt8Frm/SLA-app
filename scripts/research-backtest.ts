/**
 * Four-season backtest of the two models whose numbers people act on: the
 * expected-score model (what will this player score) and the lineup model
 * (who should I start).
 *
 * `verify:forecast` proves the fitting code recovers a planted structure and
 * `research:forecast` checks the intervals are calibrated. Neither asks the
 * question a manager actually has: *of everything we measure, what carries the
 * information?* This walks forward through real seasons, computes every signal
 * from weeks the model had already seen, and scores it against what happened.
 *
 * Two scopes, because the data has two different horizons:
 *
 *   Expected score   2022-2025. Sleeper's stats and projections are keyed by
 *                    NFL season, not by league, so four seasons are available
 *                    even though this league did not exist for the first two.
 *                    The 2024 league supplies the custom scoring throughout, so
 *                    every season is scored on today's rules.
 *
 *   Lineup decisions 2024-2025 only. A lineup needs a roster and a set of legal
 *                    slots, which exist only for seasons the league played.
 *                    Sleeper's `previous_league_id` chain ends at 2024, so
 *                    there is no earlier roster history to recover.
 *
 * Every feature for week w is built from weeks < w, and the residual model is
 * refit on weeks < w before each evaluation. Nothing sees its own outcome.
 */

import { computeOptimalLineup, starterSlots, type LineupCandidate } from '../src/lib/optimal';
import { biasShiftFor, fitResidualModel, type ResidualModel } from '../src/lib/forecast';
import {
  compileScoring,
  createScorer,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
  type ScoringModel,
} from '../src/lib/scoring';
import { getAllPlayers, getLeague, getMatchups, getRosters, getWeekProjections, getWeekStats } from '../src/lib/sleeper';
import { mean } from '../src/lib/stats';
import { POSITION_GROUPS, type Matchup, type Player, type PositionGroup, type StatLine } from '../src/lib/types';

/** Scoring source per season. 2022-23 predate the league; 2024's rules apply. */
const SCORING_LEAGUE: Record<string, string> = {
  '2022': '1122650835105759232',
  '2023': '1122650835105759232',
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
};
/** Seasons whose rosters and matchups exist, so lineups can be replayed. */
const LEAGUE_SEASONS: Record<string, string> = {
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
};

const WEEKS = 17;
/** Four prior weeks must exist before a form signal means anything. */
const FIRST_TARGET_WEEK = 5;
/** Exponential decay for the weighted-form signal, matching the app's usage. */
const EWMA_DECAY = 0.75;

interface SeasonData {
  season: string;
  scoringModel: ScoringModel;
  score: (line: StatLine | undefined) => number;
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekTeams: Map<number, Record<string, string>>;
  matchups: Map<number, Matchup[]>;
  slots: string[];
  /**
   * Players on the taxi squad or reserve list. Sleeper's per-week
   * `matchup.players` includes both, so an unfiltered pool lets a model "start"
   * someone the manager was not allowed to start. Membership is only available
   * as of today, not per week, so this bounds the effect rather than measuring
   * it exactly.
   */
  unstartable: Set<string>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

async function loadSeason(season: string): Promise<SeasonData> {
  const leagueId = LEAGUE_SEASONS[season] ?? SCORING_LEAGUE[season];
  const league = await getLeague(SCORING_LEAGUE[season]);
  const scoringModel = compileScoring(league.scoring_settings);
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekTeams = new Map<number, Record<string, string>>();
  const matchups = new Map<number, Matchup[]>();

  const weeks = Array.from({ length: WEEKS }, (_, i) => i + 1);
  await mapLimit(weeks, 6, async (week) => {
    const [stats, projections, weekMatchups] = await Promise.all([
      getWeekStats(season, week, 'regular'),
      getWeekProjections(season, week, 'regular'),
      LEAGUE_SEASONS[season]
        ? getMatchups(leagueId, week).catch(() => [] as Matchup[])
        : Promise.resolve([] as Matchup[]),
    ]);
    weekStats.set(week, stats.stats);
    weekProjections.set(week, projections.stats);
    weekTeams.set(week, stats.teams);
    matchups.set(week, weekMatchups);
  });

  const unstartable = new Set<string>();
  if (LEAGUE_SEASONS[season]) {
    for (const roster of await getRosters(leagueId).catch(() => [])) {
      for (const pid of [...(roster.taxi ?? []), ...(roster.reserve ?? [])]) {
        if (pid) unstartable.add(String(pid));
      }
    }
  }

  return {
    season,
    scoringModel,
    score: createScorer(scoringModel),
    weekStats,
    weekProjections,
    weekTeams,
    matchups,
    slots: starterSlots(league.roster_positions),
    unstartable,
  };
}

/* ------------------------------------------------------------------ *
 * Signals. Each is computed for a player entering week w, from that
 * player's completed weeks strictly before w.
 * ------------------------------------------------------------------ */

interface Signals {
  projection: number;
  corrected: number;
  ppg: number | null;
  last4: number | null;
  ewma: number | null;
  /** The blend the app's value model leans on: recent form over the season. */
  form: number | null;
}

function ewmaOf(values: number[]): number | null {
  if (!values.length) return null;
  let weighted = 0;
  let weight = 0;
  // Most recent first, so index 0 carries full weight.
  for (const [index, value] of [...values].reverse().entries()) {
    const w = EWMA_DECAY ** index;
    weighted += value * w;
    weight += w;
  }
  return weight ? weighted / weight : null;
}

function signalsFor(history: number[], projection: number, corrected: number): Signals {
  const ppg = history.length ? mean(history) : null;
  const last4 = history.length ? mean(history.slice(-4)) : null;
  const ewma = ewmaOf(history);
  return {
    projection,
    corrected,
    ppg,
    last4,
    ewma,
    form: ewma === null || ppg === null ? null : 0.6 * ewma + 0.4 * ppg,
  };
}

/* ------------------------------------------------------------------ *
 * Least squares, standardized so coefficients are comparable.
 * ------------------------------------------------------------------ */

/** Solves A·x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Standardized OLS. Returns one coefficient per feature, each read as "points
 * of outcome per standard deviation of this feature, holding the others fixed"
 * — which is the comparison the raw units do not allow.
 */
function standardizedWeights(rows: Array<{ features: number[]; outcome: number }>, names: string[]) {
  if (rows.length <= names.length + 1) return null;
  const n = names.length;
  const means = names.map((_, j) => mean(rows.map((r) => r.features[j])));
  const sds = names.map((_, j) => {
    const mu = means[j];
    return Math.sqrt(mean(rows.map((r) => (r.features[j] - mu) ** 2))) || 1;
  });
  const outcomeMean = mean(rows.map((r) => r.outcome));

  const z = rows.map((r) => r.features.map((value, j) => (value - means[j]) / sds[j]));
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const [i, row] of z.entries()) {
    const centered = rows[i].outcome - outcomeMean;
    for (let j = 0; j < n; j++) {
      b[j] += row[j] * centered;
      for (let k = 0; k < n; k++) a[j][k] += row[j] * row[k];
    }
  }
  const coefficients = solve(a, b);
  if (!coefficients) return null;
  return names.map((name, j) => ({ name, weight: coefficients[j] }));
}

/* ------------------------------------------------------------------ *
 * Error accounting.
 * ------------------------------------------------------------------ */

class Accuracy {
  private absolute = 0;
  private squared = 0;
  private signed = 0;
  private n = 0;
  private xs: number[] = [];
  private ys: number[] = [];

  add(predicted: number, actual: number): void {
    const error = predicted - actual;
    this.absolute += Math.abs(error);
    this.squared += error * error;
    this.signed += error;
    this.n++;
    this.xs.push(predicted);
    this.ys.push(actual);
  }

  get count(): number { return this.n; }
  get mae(): number { return this.n ? this.absolute / this.n : NaN; }
  get rmse(): number { return this.n ? Math.sqrt(this.squared / this.n) : NaN; }
  get bias(): number { return this.n ? this.signed / this.n : NaN; }

  get correlation(): number {
    if (this.n < 2) return NaN;
    const mx = mean(this.xs);
    const my = mean(this.ys);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = this.xs[i] - mx;
      const dy = this.ys[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
}

const SIGNAL_NAMES = ['projection', 'corrected', 'ppg', 'last4', 'ewma', 'form'] as const;
type SignalName = (typeof SIGNAL_NAMES)[number];

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}
function f1(n: number): string { return Number.isFinite(n) ? n.toFixed(1) : '—'; }
function f2(n: number): string { return Number.isFinite(n) ? n.toFixed(2) : '—'; }
function f3(n: number): string { return Number.isFinite(n) ? n.toFixed(3) : '—'; }

async function main(): Promise<void> {
  const players = new Map<string, Player>(Object.entries(await getAllPlayers()));
  const seasons = Object.keys(SCORING_LEAGUE).sort();
  console.log(`Loading ${seasons.join(', ')} …`);
  const loaded = new Map<string, SeasonData>();
  for (const season of seasons) loaded.set(season, await loadSeason(season));

  /* ---------------- Part A: expected score, per player-week ---------------- */

  const overall = new Map<SignalName, Accuracy>(SIGNAL_NAMES.map((name) => [name, new Accuracy()]));
  const byGroup = new Map<PositionGroup, Map<SignalName, Accuracy>>(
    POSITION_GROUPS.map((group) => [group, new Map(SIGNAL_NAMES.map((name) => [name, new Accuracy()]))]),
  );
  const bySeason = new Map<string, Map<SignalName, Accuracy>>(
    seasons.map((season) => [season, new Map(SIGNAL_NAMES.map((name) => [name, new Accuracy()]))]),
  );
  const regression: Array<{ features: number[]; outcome: number }> = [];
  const regressionNames = ['projection', 'ppg', 'last4', 'ewma'];

  for (const season of seasons) {
    const data = loaded.get(season)!;
    // Running per-player history of completed weeks, extended as weeks are consumed.
    const history = new Map<string, number[]>();
    for (let week = 1; week < FIRST_TARGET_WEEK; week++) {
      const stats = data.weekStats.get(week) ?? {};
      for (const [pid, line] of Object.entries(stats)) {
        if (!hasPlayed(line)) continue;
        history.set(pid, [...(history.get(pid) ?? []), data.score(line)]);
      }
    }

    for (let week = FIRST_TARGET_WEEK; week <= WEEKS; week++) {
      // Refit on weeks strictly before this one: the correction never sees the
      // week it is being scored on.
      const residual: ResidualModel = fitResidualModel({
        scoringModel: data.scoringModel,
        playersById: players,
        weekStats: data.weekStats,
        weekProjections: data.weekProjections,
        weekTeams: data.weekTeams,
        throughWeek: week - 1,
      });

      const stats = data.weekStats.get(week) ?? {};
      const projections = data.weekProjections.get(week) ?? {};

      for (const [pid, projectionLine] of Object.entries(projections)) {
        if (!hasValidProjection(projectionLine)) continue;
        const line = stats[pid];
        if (!hasPlayed(line)) continue;
        const group = groupForPlayer(players.get(pid));
        if (!group) continue;

        const projection = data.score(projectionLine);
        if (projection <= 0) continue;
        const actual = data.score(line);
        const past = history.get(pid) ?? [];
        const corrected = projection + biasShiftFor(residual, pid, group, projection);
        const signals = signalsFor(past, projection, corrected);

        for (const name of SIGNAL_NAMES) {
          const value = signals[name];
          if (value === null || !Number.isFinite(value)) continue;
          overall.get(name)!.add(value, actual);
          byGroup.get(group)!.get(name)!.add(value, actual);
          bySeason.get(season)!.get(name)!.add(value, actual);
        }

        if (signals.ppg !== null && signals.last4 !== null && signals.ewma !== null) {
          regression.push({
            features: [signals.projection, signals.ppg, signals.last4, signals.ewma],
            outcome: actual,
          });
        }
      }

      for (const [pid, line] of Object.entries(stats)) {
        if (!hasPlayed(line)) continue;
        history.set(pid, [...(history.get(pid) ?? []), data.score(line)]);
      }
    }
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log('EXPECTED SCORE — player-week, 2022-2025, walk-forward');
  console.log('═'.repeat(78));
  console.log(`${pad('signal', 12)}${padStart('n', 8)}${padStart('MAE', 8)}${padStart('RMSE', 8)}${padStart('bias', 8)}${padStart('corr', 8)}`);
  for (const name of SIGNAL_NAMES) {
    const a = overall.get(name)!;
    console.log(`${pad(name, 12)}${padStart(String(a.count), 8)}${padStart(f2(a.mae), 8)}${padStart(f2(a.rmse), 8)}${padStart(f2(a.bias), 8)}${padStart(f3(a.correlation), 8)}`);
  }

  console.log(`\n${pad('by position', 12)}${SIGNAL_NAMES.map((n) => padStart(n.slice(0, 6), 9)).join('')}   (MAE)`);
  for (const group of POSITION_GROUPS) {
    const row = byGroup.get(group)!;
    if (!row.get('projection')!.count) continue;
    console.log(`${pad(group, 12)}${SIGNAL_NAMES.map((n) => padStart(f2(row.get(n)!.mae), 9)).join('')}`);
  }

  console.log(`\n${pad('by season', 12)}${SIGNAL_NAMES.map((n) => padStart(n.slice(0, 6), 9)).join('')}   (MAE)`);
  for (const season of seasons) {
    const row = bySeason.get(season)!;
    console.log(`${pad(season, 12)}${SIGNAL_NAMES.map((n) => padStart(f2(row.get(n)!.mae), 9)).join('')}`);
  }

  const weights = standardizedWeights(regression, regressionNames);
  if (weights) {
    console.log(`\nStandardized weights (points per SD, all four fit together, n=${regression.length}):`);
    for (const { name, weight } of [...weights].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))) {
      const bar = '█'.repeat(Math.max(0, Math.round(Math.abs(weight) * 4)));
      console.log(`  ${pad(name, 12)}${padStart(f2(weight), 7)}  ${bar}`);
    }
    console.log('  A near-zero weight means the signal adds nothing the others do not already carry.');
  }

  /* ---------------- Part B: lineup decisions ---------------- */

  const lineupSignals: SignalName[] = ['projection', 'corrected', 'ppg', 'last4', 'ewma', 'form'];
  type Tally = { model: number; optimal: number; weeks: number };
  const makeTally = () => new Map<string, Tally>(
    [...lineupSignals, 'manager'].map((name) => [name, { model: 0, optimal: 0, weeks: 0 }]),
  );
  // Run twice: the whole roster as Sleeper reports it, then again with taxi and
  // reserve removed, so the model is held to lineups the manager could have set.
  const passes = [
    { label: 'full roster pool', restrict: false, captured: makeTally() },
    { label: 'startable only (taxi and IR removed)', restrict: true, captured: makeTally() },
  ];
  let lineupWeeks = 0;

  for (const season of Object.keys(LEAGUE_SEASONS)) {
    const data = loaded.get(season)!;
    const history = new Map<string, number[]>();
    for (let week = 1; week < FIRST_TARGET_WEEK; week++) {
      const stats = data.weekStats.get(week) ?? {};
      for (const [pid, line] of Object.entries(stats)) {
        if (!hasPlayed(line)) continue;
        history.set(pid, [...(history.get(pid) ?? []), data.score(line)]);
      }
    }

    for (let week = FIRST_TARGET_WEEK; week <= WEEKS; week++) {
      const residual = fitResidualModel({
        scoringModel: data.scoringModel,
        playersById: players,
        weekStats: data.weekStats,
        weekProjections: data.weekProjections,
        weekTeams: data.weekTeams,
        throughWeek: week - 1,
      });
      const stats = data.weekStats.get(week) ?? {};
      const projections = data.weekProjections.get(week) ?? {};

      for (const matchup of data.matchups.get(week) ?? []) {
        const roster = (matchup.players ?? []).map(String).filter(Boolean);
        const started = (matchup.starters ?? []).map(String).filter(Boolean);
        if (!roster.length || !started.length) continue;

        const pool = roster.flatMap((pid) => {
          const group = groupForPlayer(players.get(pid));
          if (!group) return [];
          const actual = hasPlayed(stats[pid]) ? data.score(stats[pid]) : 0;
          const projectionLine = projections[pid];
          const projection = hasValidProjection(projectionLine) ? data.score(projectionLine) : 0;
          const corrected = projection > 0
            ? projection + biasShiftFor(residual, pid, group, projection)
            : 0;
          return [{
            pid,
            group,
            actual,
            signals: signalsFor(history.get(pid) ?? [], projection, corrected),
          }];
        });
        if (!pool.length) continue;

        const actualByPid = new Map(pool.map((p) => [p.pid, p.actual]));
        // The manager's own lineup is what it is; it is never restricted, since
        // whatever they started was by definition legal.
        const managerTotal = started.reduce((sum, pid) => sum + (actualByPid.get(pid) ?? 0), 0);

        for (const pass of passes) {
          const eligible = pass.restrict
            ? pool.filter((p) => !data.unstartable.has(p.pid) || started.includes(p.pid))
            : pool;
          if (!eligible.length) continue;

          const optimal = computeOptimalLineup(
            data.slots,
            eligible.map((p): LineupCandidate => ({ pid: p.pid, group: p.group, points: p.actual })),
          ).total;
          if (optimal <= 0) continue;

          const managerRow = pass.captured.get('manager')!;
          managerRow.model += managerTotal;
          managerRow.optimal += optimal;
          managerRow.weeks++;

          for (const name of lineupSignals) {
            // A player with no value for this signal still has to be startable,
            // or the comparison silently rewards signals with more gaps.
            const chosen = computeOptimalLineup(
              data.slots,
              eligible.map((p): LineupCandidate => ({
                pid: p.pid,
                group: p.group,
                points: p.signals[name] ?? 0,
              })),
            );
            const total = chosen.assignments.reduce(
              (sum, slot) => sum + (slot.pid ? actualByPid.get(slot.pid) ?? 0 : 0),
              0,
            );
            const row = pass.captured.get(name)!;
            row.model += total;
            row.optimal += optimal;
            row.weeks++;
          }
        }
        lineupWeeks++;
      }

      for (const [pid, line] of Object.entries(stats)) {
        if (!hasPlayed(line)) continue;
        history.set(pid, [...(history.get(pid) ?? []), data.score(line)]);
      }
    }
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`LINEUP DECISIONS — ${Object.keys(LEAGUE_SEASONS).join(', ')}, ${lineupWeeks} team-weeks`);
  console.log('═'.repeat(78));
  console.log('Each signal picks a legal lineup before the week; the lineup is then scored');
  console.log('on what actually happened. "of optimal" is against perfect hindsight.');

  for (const pass of passes) {
    console.log(`\n── ${pass.label} ${'─'.repeat(Math.max(0, 60 - pass.label.length))}`);
    console.log(`${pad('signal', 12)}${padStart('pts/wk', 9)}${padStart('of optimal', 12)}${padStart('vs manager', 12)}`);
    const manager = pass.captured.get('manager')!;
    const managerPerWeek = manager.weeks ? manager.model / manager.weeks : NaN;
    for (const name of ['manager', ...lineupSignals]) {
      const row = pass.captured.get(name)!;
      if (!row.weeks) continue;
      const perWeek = row.model / row.weeks;
      const share = row.optimal ? row.model / row.optimal : NaN;
      const delta = perWeek - managerPerWeek;
      const deltaText = name === 'manager' ? '—' : `${delta >= 0 ? '+' : ''}${f1(delta)}`;
      console.log(`${pad(name, 12)}${padStart(f1(perWeek), 9)}${padStart(`${f1(share * 100)}%`, 12)}${padStart(deltaText, 12)}`);
    }
    console.log(`${pad('optimal', 12)}${padStart(f1(manager.weeks ? manager.optimal / manager.weeks : NaN), 9)}${padStart('100.0%', 12)}`);
  }

  console.log('\nRead the lineup table as a ceiling on what better ranking can buy: the gap');
  console.log('between the best signal and "optimal" is variance no pregame number removes.');
  console.log('Taxi and reserve membership is only known as of today, so the restricted');
  console.log('pass is an approximation of that week\'s eligibility, not a record of it.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
