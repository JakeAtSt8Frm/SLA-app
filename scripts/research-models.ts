/**
 * Cross-season model research.
 *
 * Downloads 2024 and 2025 player-week data, creates leakage-safe observations
 * (only weeks before the target are available), and reports which candidate
 * signals improve next-week player and matchup prediction out of sample.
 */

import { buildMatchupIndex } from '../src/lib/matchup';
import {
  createScorer,
  efficiency,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
  opportunities,
  snapPct,
} from '../src/lib/scoring';
import {
  getAllPlayers,
  getLeague,
  getWeekProjections,
  getWeekStats,
} from '../src/lib/sleeper';
import { mean, percentileRanks, quantile, stdev } from '../src/lib/stats';
import { buildValueIndex } from '../src/lib/value';
import type { Player, PositionGroup, StatLine } from '../src/lib/types';
import { POSITION_GROUPS } from '../src/lib/types';

const LEAGUES: Record<string, string> = {
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
};
const WEEKS = 17;
const FIRST_TARGET_WEEK = 5;

interface PlayerWeek {
  season: string;
  week: number;
  pid: string;
  group: PositionGroup;
  team: string;
  opponent: string;
  actual: number;
  projected: number | null;
  opportunities: number | null;
  opportunityShare: number | null;
  snaps: number | null;
  efficiency: number | null;
}

interface DefenseWeek {
  season: string;
  week: number;
  group: PositionGroup;
  defense: string;
  sourceTeam: string;
  points: number;
  opportunities: number;
  performers: number;
}

interface SeasonDataset {
  season: string;
  players: Map<string, Player>;
  scoringModel: ReturnType<typeof import('../src/lib/scoring').compileScoring>;
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekOpponents: Map<number, Record<string, string>>;
  weekTeams: Map<number, Record<string, string>>;
  playerWeeks: PlayerWeek[];
  byPlayer: Map<string, PlayerWeek[]>;
  defenseWeeks: DefenseWeek[];
  byDefenseGroup: Map<string, DefenseWeek[]>;
  byTeamGroup: Map<string, DefenseWeek[]>;
}

type FeatureRow = {
  season: string;
  week: number;
  group: PositionGroup;
  outcome: number;
  [feature: string]: string | number | PositionGroup;
};

function key(...parts: Array<string | number>): string {
  return parts.join('|');
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadSeason(
  season: string,
  players: Map<string, Player>,
): Promise<SeasonDataset> {
  const league = await getLeague(LEAGUES[season]);
  const { compileScoring } = await import('../src/lib/scoring');
  const scoringModel = compileScoring(league.scoring_settings);
  const score = createScorer(scoringModel);
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();

  const payloads = await mapLimit(
    Array.from({ length: WEEKS }, (_, index) => index + 1),
    4,
    async (week) => {
      process.stdout.write(`\rDownloading ${season} week ${week}/${WEEKS}…   `);
      const [stats, projections] = await Promise.all([
        getWeekStats(season, week, 'regular'),
        getWeekProjections(season, week, 'regular'),
      ]);
      return { week, stats, projections };
    },
  );
  process.stdout.write('\n');

  for (const { week, stats, projections } of payloads) {
    weekStats.set(week, stats.stats);
    weekProjections.set(week, projections.stats);
    weekOpponents.set(week, stats.opponents);
    weekTeams.set(week, stats.teams);
  }

  const playerWeeks: PlayerWeek[] = [];
  const teamOpportunityTotals = new Map<string, number>();

  for (let week = 1; week <= WEEKS; week++) {
    const stats = weekStats.get(week) ?? {};
    const projections = weekProjections.get(week) ?? {};
    const opponents = weekOpponents.get(week) ?? {};
    const teams = weekTeams.get(week) ?? {};

    for (const [pid, line] of Object.entries(stats)) {
      if (!hasPlayed(line)) continue;
      const group = groupForPlayer(players.get(pid));
      const team = teams[pid];
      const opponent = opponents[pid];
      if (!group || !team || !opponent) continue;
      const opp = opportunities(group, line);
      if (opp !== null) {
        const totalKey = key(week, team, group);
        teamOpportunityTotals.set(totalKey, (teamOpportunityTotals.get(totalKey) ?? 0) + opp);
      }

      const projection = projections[pid];
      const actual = score(line);
      playerWeeks.push({
        season,
        week,
        pid,
        group,
        team,
        opponent,
        actual,
        projected: hasValidProjection(projection) ? score(projection) : null,
        opportunities: opp,
        opportunityShare: null,
        snaps: snapPct(line),
        efficiency: efficiency(group, line, actual),
      });
    }
  }

  for (const row of playerWeeks) {
    if (row.opportunities === null) continue;
    const total = teamOpportunityTotals.get(key(row.week, row.team, row.group)) ?? 0;
    row.opportunityShare = total > 0 ? row.opportunities / total : null;
  }

  const byPlayer = new Map<string, PlayerWeek[]>();
  for (const row of playerWeeks) {
    const rows = byPlayer.get(row.pid);
    if (rows) rows.push(row);
    else byPlayer.set(row.pid, [row]);
  }

  const defenseAggregate = new Map<string, DefenseWeek>();
  for (const row of playerWeeks) {
    const aggregateKey = key(row.week, row.group, row.opponent);
    let aggregate = defenseAggregate.get(aggregateKey);
    if (!aggregate) {
      aggregate = {
        season,
        week: row.week,
        group: row.group,
        defense: row.opponent,
        sourceTeam: row.team,
        points: 0,
        opportunities: 0,
        performers: 0,
      };
      defenseAggregate.set(aggregateKey, aggregate);
    }
    aggregate.points += row.actual;
    aggregate.opportunities += row.opportunities ?? 0;
    aggregate.performers++;
  }

  const defenseWeeks = [...defenseAggregate.values()];
  const byDefenseGroup = new Map<string, DefenseWeek[]>();
  const byTeamGroup = new Map<string, DefenseWeek[]>();
  for (const row of defenseWeeks) {
    const defenseKey = key(row.group, row.defense);
    const defenseRows = byDefenseGroup.get(defenseKey);
    if (defenseRows) defenseRows.push(row);
    else byDefenseGroup.set(defenseKey, [row]);

    const teamKey = key(row.group, row.sourceTeam);
    const teamRows = byTeamGroup.get(teamKey);
    if (teamRows) teamRows.push(row);
    else byTeamGroup.set(teamKey, [row]);
  }

  return {
    season,
    players,
    scoringModel,
    weekStats,
    weekProjections,
    weekOpponents,
    weekTeams,
    playerWeeks,
    byPlayer,
    defenseWeeks,
    byDefenseGroup,
    byTeamGroup,
  };
}

function recentMean(values: number[], size: number): number {
  return mean(values.slice(-size));
}

function ewma(values: number[], decay = 0.68): number {
  if (!values.length) return 0;
  let weighted = 0;
  let weight = 0;
  let current = 1;
  for (let index = values.length - 1; index >= 0; index--) {
    weighted += values[index] * current;
    weight += current;
    current *= decay;
  }
  return weight ? weighted / weight : 0;
}

function validMean(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? mean(valid) : null;
}

function buildPlayerObservations(dataset: SeasonDataset): FeatureRow[] {
  const observations: FeatureRow[] = [];

  for (let targetWeek = FIRST_TARGET_WEEK; targetWeek <= WEEKS; targetWeek++) {
    const historyStats = new Map(
      [...dataset.weekStats].filter(([week]) => week < targetWeek),
    );
    const historyProjections = new Map(
      [...dataset.weekProjections].filter(([week]) => week < targetWeek),
    );
    const historyOpponents = new Map(
      [...dataset.weekOpponents].filter(([week]) => week < targetWeek),
    );

    const valueIndex = buildValueIndex({
      scoringModel: dataset.scoringModel,
      playersById: dataset.players,
      weekStats: historyStats,
      weekProjections: historyProjections,
      weekOpponents: historyOpponents,
      weekTeams: new Map([...dataset.weekTeams].filter(([week]) => week < targetWeek)),
      forecastProjections: dataset.weekProjections.get(targetWeek),
      throughWeek: targetWeek - 1,
    });
    const matchupIndex = buildMatchupIndex({
      scoringModel: dataset.scoringModel,
      playersById: dataset.players,
      weekStats: historyStats,
      weekOpponents: historyOpponents,
      weekTeams: new Map([...dataset.weekTeams].filter(([week]) => week < targetWeek)),
      throughWeek: targetWeek - 1,
    });

    const groupPlayerScores = new Map<PositionGroup, number[]>();
    const defenseIndividualScores = new Map<string, number[]>();
    for (const row of dataset.playerWeeks) {
      if (row.week >= targetWeek) continue;
      const groupScores = groupPlayerScores.get(row.group);
      if (groupScores) groupScores.push(row.actual);
      else groupPlayerScores.set(row.group, [row.actual]);

      const defenseKey = key(row.group, row.opponent);
      const defenseScores = defenseIndividualScores.get(defenseKey);
      if (defenseScores) defenseScores.push(row.actual);
      else defenseIndividualScores.set(defenseKey, [row.actual]);
    }

    const targets = dataset.playerWeeks.filter((row) => row.week === targetWeek);
    for (const target of targets) {
      const history = (dataset.byPlayer.get(target.pid) ?? []).filter(
        (row) => row.week < targetWeek,
      );
      if (history.length < 2) continue;

      const scores = history.map((row) => row.actual);
      const opps = history.map((row) => row.opportunities);
      const shares = history.map((row) => row.opportunityShare);
      const snaps = history.map((row) => row.snaps);
      const efficiencies = history.map((row) => row.efficiency);
      const deltas = history
        .filter((row) => row.projected !== null)
        .map((row) => row.actual - row.projected!);
      const groupMean = mean(groupPlayerScores.get(target.group) ?? []);

      const adjustedScores = history.map((row) => {
        const defenseMean = mean(defenseIndividualScores.get(key(row.group, row.opponent)) ?? []);
        const factor = groupMean > 0 && defenseMean > 0 ? defenseMean / groupMean : 1;
        return row.actual / Math.max(0.65, Math.min(1.35, factor));
      });

      const teamHistory = (dataset.byTeamGroup.get(key(target.group, target.team)) ?? []).filter(
        (row) => row.week < targetWeek,
      );
      const matchup = matchupIndex.get(target.group, target.opponent, target.team);
      const existing = valueIndex.byPlayer.get(target.pid);

      observations.push({
        season: dataset.season,
        week: targetWeek,
        group: target.group,
        outcome: target.actual,
        existingValue: existing?.score ?? 500,
        ppg: mean(scores),
        last4: recentMean(scores, 4),
        ewma: ewma(scores),
        floor: quantile(scores, 0.25),
        ceiling: quantile(scores, 0.85),
        consistency: 1 - Math.min(stdev(scores) / Math.max(mean(scores), 1), 1),
        availability: history.length / (targetWeek - 1),
        usage: validMean(opps) ?? 0,
        recentUsage: validMean(opps.slice(-2)) ?? 0,
        opportunityShare: validMean(shares) ?? 0,
        recentOpportunityShare: validMean(shares.slice(-2)) ?? 0,
        snaps: validMean(snaps) ?? 0,
        recentSnaps: validMean(snaps.slice(-2)) ?? 0,
        efficiency: validMean(efficiencies) ?? 0,
        projectionDelta: mean(deltas),
        scheduleAdjustedPpg: mean(adjustedScores),
        teamStrength: mean(teamHistory.map((row) => row.points)),
        matchup: matchup?.score ?? 50,
        currentProjection: target.projected ?? mean(scores),
      });
    }
  }

  return observations;
}

function buildMatchupObservations(dataset: SeasonDataset): FeatureRow[] {
  const observations: FeatureRow[] = [];

  for (let targetWeek = FIRST_TARGET_WEEK; targetWeek <= WEEKS; targetWeek++) {
    const historyStats = new Map(
      [...dataset.weekStats].filter(([week]) => week < targetWeek),
    );
    const historyOpponents = new Map(
      [...dataset.weekOpponents].filter(([week]) => week < targetWeek),
    );
    const matchupIndex = buildMatchupIndex({
      scoringModel: dataset.scoringModel,
      playersById: dataset.players,
      weekStats: historyStats,
      weekOpponents: historyOpponents,
      weekTeams: new Map([...dataset.weekTeams].filter(([week]) => week < targetWeek)),
      throughWeek: targetWeek - 1,
    });

    const groupMeans = new Map<PositionGroup, number>();
    for (const group of POSITION_GROUPS) {
      groupMeans.set(
        group,
        mean(
          dataset.defenseWeeks
            .filter((row) => row.group === group && row.week < targetWeek)
            .map((row) => row.points),
        ),
      );
    }

    for (const target of dataset.defenseWeeks.filter((row) => row.week === targetWeek)) {
      const history = (dataset.byDefenseGroup.get(key(target.group, target.defense)) ?? []).filter(
        (row) => row.week < targetWeek,
      );
      if (history.length < 2) continue;

      const points = history.map((row) => row.points);
      const opportunitiesAllowed = history.map((row) => row.opportunities);
      const efficiencyAllowed = history.map(
        (row) => row.points / Math.max(row.opportunities, 1),
      );
      const leagueMean = groupMeans.get(target.group) ?? mean(points);

      const adjusted = history.map((row) => {
        const sourceHistory = (
          dataset.byTeamGroup.get(key(row.group, row.sourceTeam)) ?? []
        ).filter((candidate) => candidate.week < targetWeek);
        const sourceMean = mean(sourceHistory.map((candidate) => candidate.points));
        return row.points - (sourceMean - leagueMean);
      });

      const sourceHistory = (
        dataset.byTeamGroup.get(key(target.group, target.sourceTeam)) ?? []
      ).filter((row) => row.week < targetWeek);
      const existing = matchupIndex.get(target.group, target.defense, target.sourceTeam);

      observations.push({
        season: dataset.season,
        week: targetWeek,
        group: target.group,
        outcome: target.points,
        existingMatchup: existing?.score ?? 50,
        seasonAllowed: mean(points),
        last4Allowed: recentMean(points, 4),
        ewmaAllowed: ewma(points),
        medianAllowed: quantile(points, 0.5),
        volatilityInverse: 1 - Math.min(stdev(points) / Math.max(mean(points), 1), 1),
        opportunitiesAllowed: mean(opportunitiesAllowed),
        recentOpportunitiesAllowed: recentMean(opportunitiesAllowed, 4),
        efficiencyAllowed: mean(efficiencyAllowed),
        opponentAdjustedAllowed: mean(adjusted),
        sourceStrength: mean(sourceHistory.map((row) => row.points)),
        sourceRecentStrength: recentMean(
          sourceHistory.map((row) => row.points),
          4,
        ),
      });
    }
  }

  return observations;
}

function percentileObservations(rows: FeatureRow[], features: string[]): FeatureRow[] {
  const buckets = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const bucketKey = key(row.season, row.week, row.group);
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.push(row);
    else buckets.set(bucketKey, [row]);
  }

  const ranked: FeatureRow[] = [];
  for (const bucket of buckets.values()) {
    const outcomeRanks = percentileRanks(
      bucket.map((row, index) => ({ id: String(index), value: Number(row.outcome) })),
    );
    const featureRanks = new Map<string, Map<string, number>>();
    for (const feature of features) {
      featureRanks.set(
        feature,
        percentileRanks(
          bucket.map((row, index) => ({
            id: String(index),
            value: Number(row[feature] ?? 0),
          })),
        ),
      );
    }

    bucket.forEach((row, index) => {
      const normalized: FeatureRow = {
        season: row.season,
        week: row.week,
        group: row.group,
        outcome: outcomeRanks.get(String(index)) ?? 0.5,
      };
      for (const feature of features) {
        normalized[feature] = featureRanks.get(feature)?.get(String(index)) ?? 0.5;
      }
      ranked.push(normalized);
    });
  }
  return ranked;
}

function correlation(rows: FeatureRow[], feature: string): number {
  if (rows.length < 2) return 0;
  const xs = rows.map((row) => Number(row[feature]));
  const ys = rows.map((row) => row.outcome);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSq = 0;
  let ySq = 0;
  for (let index = 0; index < rows.length; index++) {
    const x = xs[index] - xMean;
    const y = ys[index] - yMean;
    numerator += x * y;
    xSq += x * x;
    ySq += y * y;
  }
  return xSq > 0 && ySq > 0 ? numerator / Math.sqrt(xSq * ySq) : 0;
}

function blendedCorrelation(
  rows: FeatureRow[],
  base: string,
  feature: string,
  alpha: number,
): number {
  const blended = rows.map((row) => ({
    ...row,
    blend: Number(row[base]) * (1 - alpha) + Number(row[feature]) * alpha,
  }));
  return correlation(blended, 'blend');
}

function report(
  title: string,
  rows: FeatureRow[],
  features: string[],
  base: string,
): void {
  const ranked = percentileObservations(rows, features);
  const train = ranked.filter((row) => row.season === '2024');
  const test = ranked.filter((row) => row.season === '2025');

  console.log(`\n${'='.repeat(84)}\n${title}\n${'='.repeat(84)}`);
  console.log(`observations: ${rows.length} (${train.length} train / ${test.length} holdout)`);
  console.log('\nSignal                         2024 rho   2025 rho   best blend   holdout rho');

  for (const feature of features) {
    let bestAlpha = 0;
    let bestTrain = correlation(train, base);
    for (let step = 0; step <= 20; step++) {
      const alpha = step * 0.025;
      const score = blendedCorrelation(train, base, feature, alpha);
      if (score > bestTrain) {
        bestTrain = score;
        bestAlpha = alpha;
      }
    }

    const left = feature.padEnd(30);
    console.log(
      `${left}${correlation(train, feature).toFixed(3).padStart(9)}${correlation(test, feature)
        .toFixed(3)
        .padStart(11)}${`${Math.round(bestAlpha * 100)}%`.padStart(13)}${blendedCorrelation(
        test,
        base,
        feature,
        bestAlpha,
      )
        .toFixed(3)
        .padStart(14)}`,
    );
  }

  console.log('\nHoldout correlation by position for the current model:');
  for (const group of POSITION_GROUPS) {
    const groupRows = test.filter((row) => row.group === group);
    console.log(
      `  ${group.padEnd(3)} ${correlation(groupRows, base).toFixed(3)}  n=${groupRows.length}`,
    );
  }
}

function reportComposite(
  title: string,
  rows: FeatureRow[],
  weights: Record<string, number>,
  base: string,
): void {
  const features = [...new Set([base, ...Object.keys(weights)])];
  const ranked = percentileObservations(rows, features).map((row) => ({
    ...row,
    candidate: Object.entries(weights).reduce(
      (sum, [feature, weight]) => sum + Number(row[feature]) * weight,
      0,
    ),
  }));

  console.log(`\n${title}`);
  for (const season of ['2024', '2025']) {
    const seasonRows = ranked.filter((row) => row.season === season);
    console.log(
      `  ${season}: current ${correlation(seasonRows, base).toFixed(3)} → candidate ${correlation(
        seasonRows,
        'candidate',
      ).toFixed(3)}`,
    );
  }
}

async function main() {
  console.log('Downloading player dictionary…');
  const players = new Map<string, Player>(Object.entries(await getAllPlayers()));
  const datasets = await Promise.all(
    Object.keys(LEAGUES).map((season) => loadSeason(season, players)),
  );

  const playerRows = datasets.flatMap(buildPlayerObservations);
  const playerFeatures = [
    'existingValue',
    'ppg',
    'last4',
    'ewma',
    'floor',
    'ceiling',
    'consistency',
    'availability',
    'usage',
    'recentUsage',
    'opportunityShare',
    'recentOpportunityShare',
    'snaps',
    'recentSnaps',
    'efficiency',
    'projectionDelta',
    'scheduleAdjustedPpg',
    'teamStrength',
    'matchup',
    'currentProjection',
  ];
  report(
    'PLAYER VALUE: predicting next-week player score percentile',
    playerRows,
    playerFeatures,
    'existingValue',
  );
  reportComposite(
    'PLAYER CANDIDATE (production + recency + role + forecast)',
    playerRows,
    {
      ppg: 0.22,
      scheduleAdjustedPpg: 0.07,
      ewma: 0.16,
      last4: 0.08,
      currentProjection: 0.14,
      recentOpportunityShare: 0.12,
      recentSnaps: 0.11,
      usage: 0.04,
      floor: 0.03,
      availability: 0.02,
      efficiency: 0.01,
    },
    'existingValue',
  );

  const matchupRows = datasets.flatMap(buildMatchupObservations);
  const matchupFeatures = [
    'existingMatchup',
    'seasonAllowed',
    'last4Allowed',
    'ewmaAllowed',
    'medianAllowed',
    'volatilityInverse',
    'opportunitiesAllowed',
    'recentOpportunitiesAllowed',
    'efficiencyAllowed',
    'opponentAdjustedAllowed',
    'sourceStrength',
    'sourceRecentStrength',
  ];
  report(
    'MATCHUP SCORE: predicting next-week group points allowed percentile',
    matchupRows,
    matchupFeatures,
    'existingMatchup',
  );
  reportComposite(
    'MATCHUP CANDIDATE (defence + schedule adjustment + volume + opponent unit)',
    matchupRows,
    {
      existingMatchup: 0.35,
      opponentAdjustedAllowed: 0.15,
      opportunitiesAllowed: 0.1,
      sourceStrength: 0.4,
    },
    'existingMatchup',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
