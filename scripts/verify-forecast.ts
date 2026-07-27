/**
 * Regression checks for the forecast distributions and the Monte Carlo.
 *
 * Everything here is synthetic and deterministic. The out-of-sample accuracy
 * question — are the intervals actually calibrated against real games — is a
 * different question and lives in `npm run research:forecast`.
 */

import assert from 'node:assert/strict';

import {
  biasShiftFor,
  buildWeekForecast,
  cdfOfZ,
  fitResidualModel,
  quantileOfZ,
  scaleFor,
  type ResidualModel,
} from '../src/lib/forecast';
import { mulberry32, simulateSeason, simulateWeek } from '../src/lib/simulate';
import { compileScoring } from '../src/lib/scoring';
import type { Player, StatLine } from '../src/lib/types';

const scoringModel = compileScoring({ pass_yd: 1 });
const line = (points: number): StatLine => ({ gp: 1, pass_yd: points });

/* -------------------------------------------------------------------------- */
/* A synthetic season with known error structure                               */
/* -------------------------------------------------------------------------- */

/*
 * 120 quarterbacks over 16 weeks. The error is deliberately built with the
 * three properties the model claims to capture, so the fit can be checked
 * against ground truth it cannot see:
 *
 *   bias            actual runs 1.5 points under the projection
 *   heteroskedastic spread grows with the projection level
 *   skew            the upside tail is longer than the downside
 */
const PLAYERS = 120;
const WEEKS = 16;
const TRUE_BIAS = -1.5;

const players = new Map<string, Player>();
for (let i = 0; i < PLAYERS; i++) {
  players.set(`p${i}`, { player_id: `p${i}`, position: 'QB' });
}

const weekStats = new Map<number, Record<string, StatLine>>();
const weekProjections = new Map<number, Record<string, StatLine>>();
const weekTeams = new Map<number, Record<string, string>>();

const rng = mulberry32(42);
const standardNormal = () =>
  Math.sqrt(-2 * Math.log(Math.max(rng(), Number.MIN_VALUE))) * Math.cos(2 * Math.PI * rng());

for (let week = 1; week <= WEEKS; week++) {
  const stats: Record<string, StatLine> = {};
  const projections: Record<string, StatLine> = {};
  const teams: Record<string, string> = {};

  for (let i = 0; i < PLAYERS; i++) {
    const pid = `p${i}`;
    // Projections span 2..26 so the scale fit has a real range to work with.
    const projection = 2 + (i % 25);
    const spread = 1 + 0.35 * projection;
    // Exponentiated normal: mean-zero, right-skewed.
    const shock = Math.exp(0.55 * standardNormal()) - Math.exp(0.55 ** 2 / 2);

    projections[pid] = line(projection);
    stats[pid] = line(Math.max(0, projection + TRUE_BIAS + spread * shock));
    teams[pid] = `T${i % 32}`;
  }

  weekStats.set(week, stats);
  weekProjections.set(week, projections);
  weekTeams.set(week, teams);
}

const model = fitResidualModel({
  scoringModel,
  playersById: players,
  weekStats,
  weekProjections,
  weekTeams,
  throughWeek: WEEKS,
});

const fit = model.byGroup.get('QB');
assert(fit, 'The quarterback group must produce a fit');
assert.equal(fit.samples, PLAYERS * WEEKS, 'Every projected player-week must be used');

/* ---- the scale must grow with the projection ----------------------------- */

assert(
  fit.scaleSlope > 0.1,
  `Heteroskedasticity must be detected, got slope ${fit.scaleSlope}`,
);
assert(
  scaleFor(fit, 25) > scaleFor(fit, 5) * 1.5,
  'A 25-point projection must carry a visibly wider error bar than a 5-point one',
);

/* ---- bias must be detected ----------------------------------------------- */

/*
 * Only the direction is asserted here. `TRUE_BIAS` is the mean shift, while
 * `medianZ` estimates the median, and the lognormal shock deliberately separates
 * the two — so equating them would be testing the wrong statistic. The numeric
 * burden sits in the quantile-matching block below, which pins the fitted
 * median (and the tails) to the sample they were fit on.
 */
assert(fit.medianZ < 0, 'A source that overshoots must produce a negative median residual');
assert(fit.meanZ < 0, 'A source that overshoots must produce a negative mean residual');
assert(
  fit.medianZ < fit.meanZ,
  'Right-skewed errors must put the median below the mean',
);

/* ---- skew must survive into the shape ------------------------------------ */

const upside = quantileOfZ(fit, 0.95) - quantileOfZ(fit, 0.5);
const downside = quantileOfZ(fit, 0.5) - quantileOfZ(fit, 0.05);
assert(
  upside > downside * 1.2,
  `Right skew must be preserved: upside ${upside.toFixed(2)} vs downside ${downside.toFixed(2)}`,
);

/* ---- the shape is a valid distribution ----------------------------------- */

for (let i = 1; i < fit.shape.length; i++) {
  assert(fit.shape[i] >= fit.shape[i - 1], 'Quantile knots must be non-decreasing');
}

for (const u of [0.05, 0.2, 0.5, 0.8, 0.95]) {
  const roundTrip = cdfOfZ(fit, quantileOfZ(fit, u));
  assert(
    Math.abs(roundTrip - u) < 0.01,
    `cdfOfZ must invert quantileOfZ at ${u}, got ${roundTrip.toFixed(4)}`,
  );
}

/* ---- fitted quantiles must match the sample they were fit on ------------- */

const residualsAtFourteen: number[] = [];
for (let week = 1; week <= WEEKS; week++) {
  const stats = weekStats.get(week)!;
  const projections = weekProjections.get(week)!;
  for (const pid of Object.keys(projections)) {
    if ((projections[pid].pass_yd ?? 0) !== 14) continue;
    residualsAtFourteen.push(stats[pid].pass_yd ?? 0);
  }
}
residualsAtFourteen.sort((a, b) => a - b);

for (const q of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
  const empirical = residualsAtFourteen[Math.floor(residualsAtFourteen.length * q)];
  const predicted = 14 + scaleFor(fit, 14) * quantileOfZ(fit, q);
  assert(
    Math.abs(empirical - predicted) < 1.5,
    `Fitted q${q * 100} (${predicted.toFixed(2)}) must track the sample (${empirical.toFixed(2)})`,
  );
}

/* -------------------------------------------------------------------------- */
/* Player forecasts                                                            */
/* -------------------------------------------------------------------------- */

const forecasts = buildWeekForecast({
  model,
  scoringModel,
  playersById: players,
  projections: weekProjections.get(1)!,
  teams: weekTeams.get(1)!,
});

const healthy = [...forecasts.values()].find((f) => f.projection >= 20);
assert(healthy, 'A high projection must produce a forecast');
assert(
  healthy.p10 < healthy.median && healthy.median < healthy.p90,
  'Quantiles must be ordered',
);
assert(
  healthy.median < healthy.projection,
  'A negatively biased source must be corrected downward',
);

/* ---- an unavailable player floors at zero without collapsing the mean ---- */

/*
 * Attendance is measured only over weeks the player was projected for, so this
 * needs a season where somebody is projected and then does not appear — a bye
 * would not count, because a bye carries no projection in the first place.
 */
const flakyStats = new Map<number, Record<string, StatLine>>();
const flakyProjections = new Map<number, Record<string, StatLine>>();
for (let week = 1; week <= WEEKS; week++) {
  const stats: Record<string, StatLine> = {};
  const projections: Record<string, StatLine> = {};
  for (let i = 0; i < PLAYERS; i++) {
    const pid = `p${i}`;
    projections[pid] = line(12);
    // p24 is projected every week but only turns up in half of them.
    if (pid === 'p24' && week % 2 === 0) continue;
    stats[pid] = line(12);
  }
  flakyStats.set(week, stats);
  flakyProjections.set(week, projections);
}

const flakyModel = fitResidualModel({
  scoringModel,
  playersById: players,
  weekStats: flakyStats,
  weekProjections: flakyProjections,
  throughWeek: WEEKS,
});

const attendance = flakyModel.playsByPlayer.get('p24');
assert.equal(attendance?.projected, WEEKS, 'Every projected week must be counted');
assert.equal(attendance?.played, WEEKS / 2, 'Only weeks with a stat line count as played');

const risky = buildWeekForecast({
  model: flakyModel,
  scoringModel,
  playersById: players,
  projections: flakyProjections.get(1)!,
}).get('p24');
assert(risky, 'The player with an attendance record must still be forecast');
assert(
  risky.playProb > 0.5 && risky.playProb < 0.85,
  `Own play rate must be shrunk toward the group, got ${risky.playProb}`,
);
assert.equal(risky.p10, 0, 'A player who misses weeks must carry a zero floor at p10');
assert(risky.p90 > 0, 'A missable player must still keep a real ceiling');

/* ---- an ever-present player must not be docked for bye weeks ------------- */

const reliable = buildWeekForecast({
  model: flakyModel,
  scoringModel,
  playersById: players,
  projections: flakyProjections.get(1)!,
}).get('p0');
assert(reliable, 'A player who never misses must still be forecast');
assert(
  reliable.playProb > 0.98,
  `Perfect attendance when projected must read as near-certain, got ${reliable.playProb}` +
    ' — a share of *season* weeks would cap this near 0.94 by counting the bye twice',
);

const definitelyOut = buildWeekForecast({
  model,
  scoringModel,
  playersById: players,
  projections: weekProjections.get(1)!,
  isOut: (pid) => pid === 'p10',
});
assert.equal(definitelyOut.get('p10')?.playProb, 0, 'A player flagged out must not be projected');
assert.equal(definitelyOut.get('p10')?.mean, 0, 'An out player contributes nothing');

/* -------------------------------------------------------------------------- */
/* Per-player projection bias                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A season where one linebacker beats his projection by a fixed margin every
 * week and one matches it exactly. LB carries full damping, so the persistent
 * over-performer must be corrected upward and the neutral one left alone.
 */
const lbPlayers = new Map<string, Player>([
  ['beater', { player_id: 'beater', position: 'LB' }],
  ['neutral', { player_id: 'neutral', position: 'LB' }],
  ['rb-beater', { player_id: 'rb-beater', position: 'RB' }],
]);
for (let i = 0; i < 40; i++) {
  lbPlayers.set(`filler${i}`, { player_id: `filler${i}`, position: 'LB' });
}

const biasStats = new Map<number, Record<string, StatLine>>();
const biasProjections = new Map<number, Record<string, StatLine>>();
for (let week = 1; week <= WEEKS; week++) {
  const stats: Record<string, StatLine> = {
    beater: line(18),
    neutral: line(10),
    'rb-beater': line(18),
  };
  const projections: Record<string, StatLine> = {
    beater: line(10),
    neutral: line(10),
    'rb-beater': line(10),
  };
  /*
   * Filler spread symmetrically across seven residual values, not just two.
   * The correction measures a player's excess over his group's *median*, so the
   * group needs a smooth distribution centred on zero — a two-valued one puts
   * the median on a knife edge between clumps and shifts the whole reference.
   */
  for (let i = 0; i < 40; i++) {
    projections[`filler${i}`] = line(10);
    stats[`filler${i}`] = line(10 + (((i + week) % 7) - 3));
  }
  biasStats.set(week, stats);
  biasProjections.set(week, projections);
}

const biasModel = fitResidualModel({
  scoringModel,
  playersById: lbPlayers,
  weekStats: biasStats,
  weekProjections: biasProjections,
  throughWeek: WEEKS,
});

const beaterShift = biasShiftFor(biasModel, 'beater', 'LB', 10);
const neutralShift = biasShiftFor(biasModel, 'neutral', 'LB', 10);
assert(
  beaterShift > 4,
  `A player beating his projection by 8 every week must be corrected upward, got ${beaterShift.toFixed(2)}`,
);
assert(
  beaterShift < 8,
  `The correction must stay shrunk below the raw margin, got ${beaterShift.toFixed(2)}`,
);
assert(
  Math.abs(neutralShift) < 0.5,
  `A player who matches his projection must barely move, got ${neutralShift.toFixed(2)}`,
);

/* ---- the correction must redistribute, not inflate ----------------------- */

/*
 * Averaged over everyone, the shift has to come out at zero. It is meant to move
 * points between players, not to add them to the league — and getting the
 * reference statistic wrong is an easy way to break that. Differencing a
 * player's mean residual against the group's *median* rather than its mean
 * hands every player a small positive excess, because residuals are
 * right-skewed, and quietly lifts every team total by about five percent.
 */
const allShifts = [...biasModel.biasByPlayer.keys()]
  .filter((pid) => pid !== 'rb-beater')
  .map((pid) => biasShiftFor(biasModel, pid, 'LB', 10));
const meanShift = allShifts.reduce((s, v) => s + v, 0) / allShifts.length;
assert(
  Math.abs(meanShift) < 0.35,
  `The mean correction across a position must sit at zero, got ${meanShift.toFixed(3)}`,
);

/* ---- positions where it did not earn its place stay untouched ------------- */

assert.equal(
  biasShiftFor(biasModel, 'rb-beater', 'RB', 10),
  0,
  'Running backs carry zero damping, so no correction may be applied to them',
);

/* ---- the shift moves the whole distribution, not just the centre --------- */

const biasForecasts = buildWeekForecast({
  model: biasModel,
  scoringModel,
  playersById: lbPlayers,
  projections: biasProjections.get(1)!,
});
const beater = biasForecasts.get('beater')!;
const neutral = biasForecasts.get('neutral')!;
assert(
  beater.median > neutral.median + 4,
  'The corrected player must forecast higher than an identically projected peer',
);
assert(
  beater.p10 > neutral.p10 && beater.p90 > neutral.p90,
  'A location shift must carry the floor and the ceiling with it',
);
assert(
  Math.abs(beater.p90 - beater.p10 - (neutral.p90 - neutral.p10)) < 0.6,
  'Correcting the location must not change the width — the spread is a property of the projection level',
);

/* -------------------------------------------------------------------------- */
/* Correlation                                                                 */
/* -------------------------------------------------------------------------- */

/** Rebuilds the model with every player on one NFL team moving in lockstep. */
function correlationOf(shared: boolean): number {
  const stats = new Map<number, Record<string, StatLine>>();
  const projections = new Map<number, Record<string, StatLine>>();
  const teams = new Map<number, Record<string, string>>();
  const local = mulberry32(7);
  const draw = () =>
    Math.sqrt(-2 * Math.log(Math.max(local(), Number.MIN_VALUE))) *
    Math.cos(2 * Math.PI * local());

  for (let week = 1; week <= WEEKS; week++) {
    const s: Record<string, StatLine> = {};
    const p: Record<string, StatLine> = {};
    const t: Record<string, string> = {};
    const teamShock = new Map<string, number>();

    for (let i = 0; i < PLAYERS; i++) {
      const pid = `p${i}`;
      const team = `T${i % 8}`;
      if (!teamShock.has(team)) teamShock.set(team, draw());
      const shock = shared ? teamShock.get(team)! : draw();
      p[pid] = line(12);
      s[pid] = line(Math.max(0, 12 + 4 * shock));
      t[pid] = team;
    }

    stats.set(week, s);
    projections.set(week, p);
    teams.set(week, t);
  }

  const built = fitResidualModel({
    scoringModel,
    playersById: players,
    weekStats: stats,
    weekProjections: projections,
    weekTeams: teams,
    throughWeek: WEEKS,
  });
  return built.teamCorrelation;
}

const sharedFate = correlationOf(true);
const independent = correlationOf(false);
assert(
  sharedFate > 0.6,
  `Players moving in lockstep must read as strongly correlated, got ${sharedFate.toFixed(3)}`,
);
assert(
  independent < 0.15,
  `Independent players must read as uncorrelated, got ${independent.toFixed(3)}`,
);

/* -------------------------------------------------------------------------- */
/* Simulation                                                                  */
/* -------------------------------------------------------------------------- */

const simModel: ResidualModel = model;

const teamOf = (rosterId: number, projection: number, count: number) => ({
  rosterId,
  starters: Array.from({ length: count }, (_, i) => ({
    pid: `r${rosterId}-${i}`,
    group: 'QB' as const,
    projection,
    biasShift: 0,
    median: projection,
    mean: projection,
    sd: 4,
    p10: projection - 6,
    p25: projection - 3,
    p75: projection + 3,
    p90: projection + 6,
    playProb: 1,
    actual: null,
    nflTeam: `N${rosterId}-${i}`,
  })),
});

const lopsided = simulateWeek({
  teams: [teamOf(1, 20, 10), teamOf(2, 10, 10)],
  model: simModel,
  pairings: [{ matchupId: 1, rosterIds: [1, 2] }],
  iterations: 4000,
});
assert(
  lopsided.matchups[0].homeWinProb > 0.95,
  `A doubled projection must dominate, got ${lopsided.matchups[0].homeWinProb}`,
);

const even = simulateWeek({
  teams: [teamOf(1, 15, 10), teamOf(2, 15, 10)],
  model: simModel,
  pairings: [{ matchupId: 1, rosterIds: [1, 2] }],
  iterations: 8000,
});
assert(
  Math.abs(even.matchups[0].homeWinProb - 0.5) < 0.03,
  `Identical teams must be a coin flip, got ${even.matchups[0].homeWinProb}`,
);
// Each is rounded to four places independently, so the sum is exact only to
// within that rounding — not to machine precision.
assert(
  Math.abs(even.matchups[0].homeWinProb + even.matchups[0].awayWinProb + even.matchups[0].tieProb - 1) <
    1e-3,
  'Probabilities must sum to one',
);

/* ---- a settled result must be respected, not resampled ------------------- */

const decided = simulateWeek({
  teams: [
    {
      rosterId: 1,
      starters: teamOf(1, 15, 3).starters.map((s) => ({ ...s, actual: 60 })),
    },
    teamOf(2, 15, 3),
  ],
  model: simModel,
  pairings: [{ matchupId: 1, rosterIds: [1, 2] }],
  iterations: 2000,
});
assert.equal(decided.meanScores.get(1), 180, 'Completed players must contribute their real score');
assert.equal(
  decided.matchups[0].homeRemaining,
  0,
  'A team with nothing left to play has no remaining points',
);
assert(
  decided.matchups[0].homeWinProb > 0.999,
  'An insurmountable lead must read as won',
);

/* ---- the simulator must agree with the forecast it was handed ------------ */

/*
 * The invariant that ties the two halves together: a team's simulated mean has
 * to equal the sum of its players' stated means. It is easy to violate by
 * sampling around the wrong location — the displayed median already contains
 * the group's bias, and so does the residual draw, so centring on the median
 * applies it twice. That mistake is invisible in a screenshot and costs about
 * eight points a team, which is the difference between a coin flip and a 60/40.
 */
const agreementForecasts = buildWeekForecast({
  model,
  scoringModel,
  playersById: players,
  projections: weekProjections.get(1)!,
  teams: weekTeams.get(1)!,
});
const agreementStarters = [...agreementForecasts.values()].slice(0, 20);
const statedMean = agreementStarters.reduce((sum, p) => sum + p.mean, 0);
const simulatedMean =
  simulateWeek({
    teams: [{ rosterId: 1, starters: agreementStarters }],
    model: simModel,
    pairings: [],
    iterations: 20000,
  }).meanScores.get(1) ?? 0;

assert(
  Math.abs(simulatedMean - statedMean) < Math.max(1.5, statedMean * 0.01),
  `Simulated team mean ${simulatedMean.toFixed(1)} must match the sum of stated player means ` +
    `${statedMean.toFixed(1)} — a gap here means the sampler is centred on the wrong location`,
);

/* ---- correlation must widen a team total, not narrow it ------------------ */

/*
 * Tested against an injected correlation rather than a fitted one. The
 * synthetic season above is built from independent teams, so its *fitted*
 * correlation is correctly near zero — using it here would assert that stacking
 * does nothing, which is true of that data and tells us nothing about the copula.
 */
const correlatedStarters = teamOf(1, 15, 12).starters.map((s) => ({ ...s, nflTeam: 'SAME' }));
const spreadStarters = teamOf(2, 15, 12).starters;
const widthOf = (starters: typeof spreadStarters, rho: number) => {
  const sim = simulateWeek({
    teams: [{ rosterId: 1, starters }],
    model: { ...simModel, teamCorrelation: rho },
    pairings: [],
    iterations: 6000,
  });
  const [low, high] = sim.intervals.get(1)!;
  return high - low;
};

assert(
  widthOf(correlatedStarters, 0.35) > widthOf(spreadStarters, 0.35) * 1.15,
  'Under a real correlation, stacking a lineup into one NFL game must widen its outcomes',
);
assert(
  Math.abs(widthOf(correlatedStarters, 0) - widthOf(spreadStarters, 0)) <
    widthOf(spreadStarters, 0) * 0.08,
  'With no correlation, stacking must make no material difference',
);
assert(
  widthOf(correlatedStarters, 0.6) > widthOf(correlatedStarters, 0.2),
  'A stronger shared factor must produce a wider team total',
);

/* -------------------------------------------------------------------------- */
/* Season simulation and bracket                                               */
/* -------------------------------------------------------------------------- */

const seasonTeams = [
  teamOf(1, 24, 10),
  teamOf(2, 20, 10),
  teamOf(3, 16, 10),
  teamOf(4, 12, 10),
];

const season = simulateSeason({
  teams: seasonTeams,
  model: simModel,
  standing: new Map(
    seasonTeams.map((team) => [
      team.rosterId,
      { wins: 0, losses: 0, ties: 0, pointsFor: 0 },
    ]),
  ),
  remaining: [
    { week: 1, pairings: [[1, 2] as [number, number], [3, 4] as [number, number]] },
    { week: 2, pairings: [[1, 3] as [number, number], [2, 4] as [number, number]] },
    { week: 3, pairings: [[1, 4] as [number, number], [2, 3] as [number, number]] },
  ],
  playoffTeams: 4,
  weeksPerRound: 1,
  iterations: 3000,
});

const best = season.byTeam.get(1)!;
const worst = season.byTeam.get(4)!;
assert(
  best.titleProb > worst.titleProb,
  'The strongest roster must win the title more often than the weakest',
);
assert(
  best.expectedWins > worst.expectedWins,
  'The strongest roster must win more games',
);
assert.equal(
  Math.round([...season.byTeam.values()].reduce((sum, t) => sum + t.titleProb, 0)),
  1,
  'Exactly one champion must be crowned each iteration',
);
for (const odds of season.byTeam.values()) {
  assert.equal(odds.playoffProb, 1, 'A four-team field of four teams must always be full');
  assert(
    odds.finalProb >= odds.titleProb,
    'Reaching the final must be at least as likely as winning it',
  );
  assert(
    Math.abs(odds.seedProbs.reduce((sum, p) => sum + p, 0) - 1) < 0.01,
    'Seed probabilities must sum to one',
  );
}

/* ---- byes: a six-team field must seed the top two through --------------- */

const sixTeams = Array.from({ length: 6 }, (_, i) => teamOf(i + 1, 30 - i * 4, 8));
const sixSeason = simulateSeason({
  teams: sixTeams,
  model: simModel,
  standing: new Map(
    sixTeams.map((team, i) => [
      team.rosterId,
      { wins: 6 - i, losses: i, ties: 0, pointsFor: 1000 - i * 50 },
    ]),
  ),
  remaining: [],
  playoffTeams: 6,
  weeksPerRound: 2,
  iterations: 3000,
});
assert(sixSeason.regularSeasonComplete, 'No remaining pairings means the season is settled');
assert.equal(sixSeason.byTeam.get(1)!.topSeedProb, 1, 'A settled standing must fix the top seed');
assert(
  sixSeason.byTeam.get(1)!.finalProb > sixSeason.byTeam.get(3)!.finalProb,
  'A first-round bye must be worth something',
);

/* ---- determinism --------------------------------------------------------- */

const first = simulateWeek({
  teams: [teamOf(1, 15, 8), teamOf(2, 14, 8)],
  model: simModel,
  pairings: [{ matchupId: 1, rosterIds: [1, 2] }],
  iterations: 2000,
  seed: 99,
});
const second = simulateWeek({
  teams: [teamOf(1, 15, 8), teamOf(2, 14, 8)],
  model: simModel,
  pairings: [{ matchupId: 1, rosterIds: [1, 2] }],
  iterations: 2000,
  seed: 99,
});
assert.equal(
  first.matchups[0].homeWinProb,
  second.matchups[0].homeWinProb,
  'The same seed must produce the same odds — a re-render cannot move the number',
);

console.log('Forecast and simulation checks passed.');
console.log(
  `  fitted scale  sd = ${fit.scaleIntercept.toFixed(2)} + ${fit.scaleSlope.toFixed(3)} x projection`,
);
console.log(
  `  median shift  ${(fit.medianZ * scaleFor(fit, 14)).toFixed(2)} pts at a 14-point projection · skew ratio ${(upside / downside).toFixed(2)}`,
);
console.log(
  `  correlation    lockstep ${sharedFate.toFixed(3)} · independent ${independent.toFixed(3)}`,
);
