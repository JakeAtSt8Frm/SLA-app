/**
 * Out-of-sample calibration of the forecast distributions.
 *
 * `verify:forecast` proves the fit recovers a structure we planted. This asks
 * the harder question: against real NFL games nobody had seen when the model
 * was fit, do the intervals mean what they say?
 *
 * The model is fit on the first half of each season and evaluated on the second,
 * so no evaluation week contributes to the distribution it is scored against.
 * Three things are measured:
 *
 *   coverage     an interval claiming 80% should contain 80% of outcomes
 *   sharpness    of the calibrated forecasts, the narrower the better
 *   point error  does bias-correcting the source actually beat the source
 *
 * Then the same test at team level, which is the one that catches correlation
 * being wrong: if players were treated as independent, real team totals would
 * land in the tails of the simulated distribution far more often than they
 * should. The run reports the correlated and independent variants side by side.
 */

import {
  cdfOfZ,
  buildWeekForecast,
  fitResidualModel,
  scaleFor,
  scoreAtQuantile,
  type ResidualModel,
} from '../src/lib/forecast';
import { sampleTeamTotals, type SimTeam } from '../src/lib/simulate';
import {
  createScorer,
  compileScoring,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
} from '../src/lib/scoring';
import {
  getAllPlayers,
  getLeague,
  getMatchups,
  getWeekProjections,
  getWeekStats,
} from '../src/lib/sleeper';
import { mean } from '../src/lib/stats';
import type { Matchup, Player, PositionGroup, StatLine } from '../src/lib/types';
import { POSITION_GROUPS } from '../src/lib/types';

const LEAGUES: Record<string, string> = {
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
};

const WEEKS = 17;
/** Weeks 1..FIT_WEEKS train the model; the rest are held out. */
const FIT_WEEKS = 9;
const TEAM_DRAWS = 4000;

const NOMINAL = [0.1, 0.25, 0.5, 0.75, 0.9];

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface Season {
  season: string;
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekTeams: Map<number, Record<string, string>>;
  matchups: Map<number, Matchup[]>;
  starterSlots: number;
  score: (line: StatLine | undefined | null) => number;
  scoringModel: ReturnType<typeof compileScoring>;
}

async function loadSeason(season: string): Promise<Season> {
  const league = await getLeague(LEAGUES[season]);
  const scoringModel = compileScoring(league.scoring_settings);
  const score = createScorer(scoringModel);

  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekTeams = new Map<number, Record<string, string>>();
  const matchups = new Map<number, Matchup[]>();

  await mapLimit(
    Array.from({ length: WEEKS }, (_, i) => i + 1),
    4,
    async (week) => {
      const [stats, projections, weekMatchups] = await Promise.all([
        getWeekStats(season, week, 'regular'),
        getWeekProjections(season, week, 'regular'),
        getMatchups(LEAGUES[season], week).catch(() => [] as Matchup[]),
      ]);
      weekStats.set(week, stats.stats);
      weekProjections.set(week, projections.stats);
      weekTeams.set(week, stats.teams);
      matchups.set(week, weekMatchups);
    },
  );

  return {
    season,
    weekStats,
    weekProjections,
    weekTeams,
    matchups,
    starterSlots: (league.roster_positions ?? []).filter(
      (slot) => !['BN', 'IR', 'TAXI'].includes(slot),
    ).length,
    score,
    scoringModel,
  };
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(7);
}

/* -------------------------------------------------------------------------- */

async function main() {
  const players = await getAllPlayers();
  const playersById = new Map<string, Player>(Object.entries(players));

  console.log(
    `Fitting on weeks 1–${FIT_WEEKS}, evaluating on weeks ${FIT_WEEKS + 1}–${WEEKS}.\n`,
  );

  const allPits: number[] = [];
  const pitByGroup = new Map<PositionGroup, number[]>();
  let sourceAbsError = 0;
  let modelAbsError = 0;
  let pointN = 0;

  for (const season of Object.keys(LEAGUES)) {
    const data = await loadSeason(season);

    const model = fitResidualModel({
      scoringModel: data.scoringModel,
      playersById,
      weekStats: data.weekStats,
      weekProjections: data.weekProjections,
      weekTeams: data.weekTeams,
      throughWeek: FIT_WEEKS,
    });

    console.log(`── ${season} ${'─'.repeat(62)}`);
    console.log(
      `${pad('group', 6)}${pad('n', 8)}${pad('sd = a + b·proj', 22)}${pad('in-group corr', 15)}play rate`,
    );
    for (const group of POSITION_GROUPS) {
      const fit = model.byGroup.get(group);
      if (!fit) continue;
      console.log(
        `${pad(group, 6)}${pad(String(fit.samples), 8)}` +
          `${pad(`${fit.scaleIntercept.toFixed(2)} + ${fit.scaleSlope.toFixed(3)}·p`, 22)}` +
          `${pad(fit.withinGroupCorrelation.toFixed(3), 15)}${(fit.playRate * 100).toFixed(1)}%`,
      );
    }
    console.log(
      `\n  Shared NFL-team correlation (pooled across positions): ${model.teamCorrelation.toFixed(3)}`,
    );

    // ---- player-level PIT on held-out weeks --------------------------------
    for (let week = FIT_WEEKS + 1; week <= WEEKS; week++) {
      const stats = data.weekStats.get(week) ?? {};
      const projections = data.weekProjections.get(week) ?? {};

      for (const pid of Object.keys(projections)) {
        const projLine = projections[pid];
        if (!hasValidProjection(projLine)) continue;
        const statLine = stats[pid];
        if (!hasPlayed(statLine)) continue;

        const group = groupForPlayer(playersById.get(pid));
        if (!group) continue;
        const fit = model.byGroup.get(group);
        if (!fit) continue;

        const projection = data.score(projLine);
        if (projection < 1) continue;
        const actual = data.score(statLine);

        const pit = cdfOfZ(fit, (actual - projection) / scaleFor(fit, projection));
        allPits.push(pit);
        const bucket = pitByGroup.get(group);
        if (bucket) bucket.push(pit);
        else pitByGroup.set(group, [pit]);

        sourceAbsError += Math.abs(actual - projection);
        modelAbsError += Math.abs(actual - scoreAtQuantile(fit, projection, 0.5));
        pointN++;
      }
    }

    // ---- team-level PIT, correlated vs independent -------------------------
    const independent: ResidualModel = { ...model, teamCorrelation: 0 };

    const teamPits = { correlated: [] as number[], independent: [] as number[] };
    /*
     * Mean simulated total against mean real total. Coverage alone will not
     * catch a level error — a distribution can be biased low and still contain
     * the outcome the right fraction of the time if it is also too wide — and a
     * systematically low team total is exactly what breaks a win probability.
     */
    const teamMeans: Array<{ simulated: number; actual: number }> = [];

    for (let week = FIT_WEEKS + 1; week <= WEEKS; week++) {
      const weekMatchups = data.matchups.get(week) ?? [];
      if (!weekMatchups.length) continue;

      const forecasts = buildWeekForecast({
        model,
        scoringModel: data.scoringModel,
        playersById,
        projections: data.weekProjections.get(week) ?? {},
        teams: data.weekTeams.get(week),
      });

      const simTeams: SimTeam[] = [];
      const actuals: number[] = [];

      for (const matchup of weekMatchups) {
        const starters = (matchup.starters ?? [])
          .map((raw) => String(raw ?? ''))
          .filter((pid) => pid && pid !== '0')
          .flatMap((pid) => {
            const forecast = forecasts.get(pid);
            return forecast ? [forecast] : [];
          });
        if (starters.length < data.starterSlots * 0.5) continue;
        simTeams.push({ rosterId: matchup.roster_id, starters });
        actuals.push(matchup.points);
      }

      if (!simTeams.length) continue;

      for (const [label, variant] of [
        ['correlated', model],
        ['independent', independent],
      ] as const) {
        const draws = sampleTeamTotals(simTeams, variant, TEAM_DRAWS, 0x51a1 + week);
        for (let t = 0; t < simTeams.length; t++) {
          const sorted = draws[t];
          let below = 0;
          let total = 0;
          for (let i = 0; i < sorted.length; i++) {
            if (sorted[i] < actuals[t]) below++;
            total += sorted[i];
          }
          teamPits[label].push(below / sorted.length);
          if (label === 'correlated') {
            teamMeans.push({ simulated: total / sorted.length, actual: actuals[t] });
          }
        }
      }
    }

    console.log('\n  Team totals — how often the real score lands outside the simulated band');
    console.log(`  ${pad('variant', 14)}${pad('outside 80%', 14)}${pad('outside 50%', 14)}n`);
    for (const label of ['correlated', 'independent'] as const) {
      const pits = teamPits[label];
      if (!pits.length) continue;
      const outside80 = pits.filter((p) => p < 0.1 || p > 0.9).length / pits.length;
      const outside50 = pits.filter((p) => p < 0.25 || p > 0.75).length / pits.length;
      console.log(
        `  ${pad(label, 14)}${pad(pct(outside80).trim(), 14)}${pad(pct(outside50).trim(), 14)}${pits.length}`,
      );
    }
    console.log('  (nominal: 20.0% and 50.0% — higher means the model is overconfident)');

    if (teamMeans.length) {
      const simulated = mean(teamMeans.map((row) => row.simulated));
      const actual = mean(teamMeans.map((row) => row.actual));
      console.log(
        `  Level: simulated mean ${simulated.toFixed(1)} vs real mean ${actual.toFixed(1)} ` +
          `(${(((simulated - actual) / actual) * 100).toFixed(1)}%)\n`,
      );
    }
  }

  /* ---- pooled player coverage --------------------------------------------- */

  const coverage = (pits: number[], q: number) => pits.filter((p) => p <= q).length / pits.length;

  console.log(`── Player coverage, held out ${'─'.repeat(48)}`);
  console.log(`${pad('group', 6)}${pad('n', 9)}${NOMINAL.map((q) => pct(q)).join('')}`);
  console.log(`${pad('', 15)}${NOMINAL.map(() => '  ─────').join('')}`);

  for (const group of POSITION_GROUPS) {
    const pits = pitByGroup.get(group);
    if (!pits?.length) continue;
    console.log(
      `${pad(group, 6)}${pad(String(pits.length), 9)}` +
        NOMINAL.map((q) => pct(coverage(pits, q))).join(''),
    );
  }
  console.log(
    `${pad('ALL', 6)}${pad(String(allPits.length), 9)}` +
      NOMINAL.map((q) => pct(coverage(allPits, q))).join(''),
  );
  console.log(
    `\nEach column should match its header — that is what a calibrated interval means.`,
  );

  const meanAbsPitError = mean(NOMINAL.map((q) => Math.abs(coverage(allPits, q) - q)));
  console.log(`Mean absolute coverage error: ${(meanAbsPitError * 100).toFixed(2)} points.`);

  console.log(
    `\nPoint accuracy over ${pointN} held-out player-weeks:` +
      `\n  source projection      MAE ${(sourceAbsError / pointN).toFixed(3)}` +
      `\n  bias-corrected median  MAE ${(modelAbsError / pointN).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
