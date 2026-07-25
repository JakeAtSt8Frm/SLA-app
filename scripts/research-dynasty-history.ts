/**
 * Leakage-safe historical research for the dynasty value model.
 *
 * Each observation is an end-of-season snapshot. Features use only that season
 * and the two seasons before it; the outcome is custom-scored VORP earned in the
 * next three seasons. Model weights are selected on 2017-2020, checked on 2021,
 * and reported one final time on the untouched 2022 -> 2023-2025 holdout.
 *
 * Run with:
 *   npm run research:dynasty
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startingDepthByGroup } from '../src/lib/dynasty';
import { longevity } from '../src/lib/longevity';
import {
  createScorer,
  efficiency,
  groupForPlayer,
  hasPlayed,
  opportunities,
  snapPct,
} from '../src/lib/scoring';
import { getAllPlayers, getLeague, getWeekStats } from '../src/lib/sleeper';
import { clamp01, mean, percentileRanks } from '../src/lib/stats';
import type { Player, PositionGroup } from '../src/lib/types';
import { POSITION_GROUPS } from '../src/lib/types';

const LEAGUE_ID = '1180280389862244352';
const DATA_SEASONS = Array.from({ length: 11 }, (_, index) => 2015 + index);
const SNAPSHOT_SEASONS = [2017, 2018, 2019, 2020, 2021, 2022];
const TRAIN_SEASONS = new Set([2017, 2018, 2019, 2020]);
const VALIDATION_SEASONS = new Set([2021]);
const HOLDOUT_SEASONS = new Set([2022]);
const WEEKS = 17;
const MIN_SNAPSHOT_GAMES = 4;
const FUTURE_DISCOUNT = [1, 0.72, 0.52] as const;
const CACHE_VERSION = 2;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cachePath = resolve(root, '.cache', `dynasty-history-v${CACHE_VERSION}.json`);

interface PlayerSeason {
  pid: string;
  group: PositionGroup;
  games: number;
  total: number;
  ppg: number;
  recentPpg: number;
  ewma: number;
  usage: number | null;
  opportunityShare: number | null;
  snaps: number | null;
  efficiency: number | null;
}

interface CachedHistory {
  version: number;
  scoringKeys: number;
  seasons: Record<string, PlayerSeason[]>;
}

interface Aggregate {
  group: PositionGroup;
  games: number;
  total: number;
  scores: number[];
  usageTotal: number;
  usageGames: number;
  opportunityShareTotal: number;
  opportunityShareGames: number;
  snapTotal: number;
  snapGames: number;
  efficiencyTotal: number;
  efficiencyGames: number;
}

interface ResearchRow {
  pid: string;
  snapshot: number;
  group: PositionGroup;
  age: number | null;
  futureOneYear: number;
  futureThreeYear: number;
  productionOne: number;
  productionThree: number;
  legacyProduction: number;
  longevityRaw: number;
  longevity: number;
  young: number;
  role: number;
  roleObserved: boolean;
  currentAvailabilityRaw: number;
  availability: number;
  trend: number;
  efficiency: number;
  efficiencyObserved: boolean;
  legacyProxy: number;
  outcomeOneRank: number;
  outcomeThreeRank: number;
}

type FeatureName =
  | 'productionThree'
  | 'longevity'
  | 'role'
  | 'availability'
  | 'trend'
  | 'efficiency';

type Weights = Record<FeatureName, number>;
type WeightObjective = 'rank' | 'balanced';

const FEATURE_NAMES: FeatureName[] = [
  'productionThree',
  'longevity',
  'role',
  'availability',
  'trend',
  'efficiency',
];

function key(snapshot: number, group: PositionGroup): string {
  return `${snapshot}:${group}`;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function weightedMean(
  values: Array<{ value: number; weight: number }>,
): number {
  const valid = values.filter(
    ({ value, weight }) => Number.isFinite(value) && weight > 0,
  );
  const denominator = valid.reduce((sum, item) => sum + item.weight, 0);
  return denominator
    ? valid.reduce((sum, item) => sum + item.value * item.weight, 0) /
        denominator
    : 0;
}

function recentMean(values: number[], size: number): number {
  const recent = values.slice(-size);
  return recent.length ? mean(recent) : 0;
}

function ewma(values: number[], decay = 0.72): number {
  let value = 0;
  let denominator = 0;
  let weight = 1;
  for (let index = values.length - 1; index >= 0; index--) {
    value += values[index] * weight;
    denominator += weight;
    weight *= decay;
  }
  return denominator ? value / denominator : 0;
}

function ageAtSeason(player: Player | undefined, season: number): number | null {
  if (!player) return null;
  if (player.birth_date) {
    const born = Date.parse(player.birth_date);
    const snapshot = Date.UTC(season, 11, 31);
    if (!Number.isNaN(born) && born < snapshot) {
      return Math.floor(((snapshot - born) / (365.25 * 86_400_000)) * 10) / 10;
    }
  }

  if (typeof player.age === 'number' && Number.isFinite(player.age)) {
    return Math.max(18, player.age - (new Date().getUTCFullYear() - season));
  }
  return null;
}

function getOrCreateAggregate(
  aggregates: Map<string, Aggregate>,
  pid: string,
  group: PositionGroup,
): Aggregate {
  let aggregate = aggregates.get(pid);
  if (!aggregate) {
    aggregate = {
      group,
      games: 0,
      total: 0,
      scores: [],
      usageTotal: 0,
      usageGames: 0,
      opportunityShareTotal: 0,
      opportunityShareGames: 0,
      snapTotal: 0,
      snapGames: 0,
      efficiencyTotal: 0,
      efficiencyGames: 0,
    };
    aggregates.set(pid, aggregate);
  }
  return aggregate;
}

async function downloadHistory(
  players: Map<string, Player>,
): Promise<CachedHistory> {
  const league = await getLeague(LEAGUE_ID);
  const { compileScoring } = await import('../src/lib/scoring');
  const model = compileScoring(league.scoring_settings);
  const score = createScorer(model);
  const seasons: Record<string, PlayerSeason[]> = {};

  for (const season of DATA_SEASONS) {
    const payloads = await mapLimit(
      Array.from({ length: WEEKS }, (_, index) => index + 1),
      6,
      async (week) => {
        process.stdout.write(`\rDownloading ${season} week ${week}/${WEEKS}…   `);
        return getWeekStats(String(season), week, 'regular');
      },
    );

    const aggregates = new Map<string, Aggregate>();
    for (const payload of payloads) {
      const teamUsage = new Map<string, number>();
      for (const [pid, line] of Object.entries(payload.stats)) {
        if (!hasPlayed(line)) continue;
        const group = groupForPlayer(players.get(pid));
        const team = payload.teams[pid];
        if (!group || !team) continue;
        const usage = opportunities(group, line);
        if (usage === null) continue;
        const usageKey = `${team}:${group}`;
        teamUsage.set(usageKey, (teamUsage.get(usageKey) ?? 0) + usage);
      }

      for (const [pid, line] of Object.entries(payload.stats)) {
        if (!hasPlayed(line)) continue;
        const group = groupForPlayer(players.get(pid));
        if (!group) continue;

        const scored = score(line);
        const aggregate = getOrCreateAggregate(aggregates, pid, group);
        aggregate.games++;
        aggregate.total += scored;
        aggregate.scores.push(scored);

        const usage = opportunities(group, line);
        if (usage !== null) {
          aggregate.usageTotal += usage;
          aggregate.usageGames++;
          const team = payload.teams[pid];
          const teamTotal = team ? teamUsage.get(`${team}:${group}`) : 0;
          if (teamTotal && teamTotal > 0) {
            aggregate.opportunityShareTotal += usage / teamTotal;
            aggregate.opportunityShareGames++;
          }
        }

        const snaps = snapPct(line);
        if (snaps !== null) {
          aggregate.snapTotal += snaps;
          aggregate.snapGames++;
        }

        const perOpportunity = efficiency(group, line, scored);
        if (perOpportunity !== null) {
          aggregate.efficiencyTotal += perOpportunity;
          aggregate.efficiencyGames++;
        }
      }
    }

    seasons[String(season)] = [...aggregates].map(([pid, aggregate]) => ({
      pid,
      group: aggregate.group,
      games: aggregate.games,
      total: aggregate.total,
      ppg: aggregate.total / aggregate.games,
      recentPpg: recentMean(aggregate.scores, 4),
      ewma: ewma(aggregate.scores),
      usage:
        aggregate.usageGames > 0
          ? aggregate.usageTotal / aggregate.usageGames
          : null,
      opportunityShare:
        aggregate.opportunityShareGames > 0
          ? aggregate.opportunityShareTotal / aggregate.opportunityShareGames
          : null,
      snaps:
        aggregate.snapGames > 0
          ? aggregate.snapTotal / aggregate.snapGames
          : null,
      efficiency:
        aggregate.efficiencyGames > 0
          ? aggregate.efficiencyTotal / aggregate.efficiencyGames
          : null,
    }));
    process.stdout.write(
      `\rDownloaded ${season}: ${seasons[String(season)].length} players${' '.repeat(20)}\n`,
    );
  }

  return {
    version: CACHE_VERSION,
    scoringKeys: model.keys.length,
    seasons,
  };
}

async function loadHistory(
  players: Map<string, Player>,
): Promise<CachedHistory> {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as CachedHistory;
    if (
      cached.version === CACHE_VERSION &&
      DATA_SEASONS.every((season) => cached.seasons[String(season)])
    ) {
      console.log(`Using cached historical aggregates: ${cachePath}`);
      return cached;
    }
  } catch {
    // A missing or obsolete cache is expected on the first run.
  }

  const history = await downloadHistory(players);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(history));
  return history;
}

function seasonMaps(history: CachedHistory): Map<number, Map<string, PlayerSeason>> {
  return new Map(
    Object.entries(history.seasons).map(([season, rows]) => [
      Number(season),
      new Map(rows.map((row) => [row.pid, row])),
    ]),
  );
}

function replacementLevels(
  season: Map<string, PlayerSeason>,
  depths: Map<PositionGroup, number>,
): Map<PositionGroup, number> {
  const replacements = new Map<PositionGroup, number>();
  for (const group of POSITION_GROUPS) {
    const ppg = [...season.values()]
      .filter((row) => row.group === group && row.games >= MIN_SNAPSHOT_GAMES)
      .map((row) => row.ppg)
      .sort((left, right) => right - left);
    if (!ppg.length) {
      replacements.set(group, 0);
      continue;
    }

    const index = Math.max(0, Math.min(ppg.length - 1, Math.round(depths.get(group) ?? 1) - 1));
    const sample = ppg.slice(Math.max(0, index - 1), Math.min(ppg.length, index + 2));
    replacements.set(group, mean(sample));
  }
  return replacements;
}

function futureVorp(
  pid: string,
  group: PositionGroup,
  snapshot: number,
  horizon: number,
  seasons: Map<number, Map<string, PlayerSeason>>,
  replacements: Map<number, Map<PositionGroup, number>>,
): number {
  let value = 0;
  for (let offset = 1; offset <= horizon; offset++) {
    const future = seasons.get(snapshot + offset)?.get(pid);
    if (!future) continue;
    const replacement = replacements.get(snapshot + offset)?.get(group) ?? 0;
    value +=
      Math.max(0, future.ppg - replacement) *
      future.games *
      FUTURE_DISCOUNT[offset - 1];
  }
  return value;
}

function rankFeature(
  rows: ResearchRow[],
  pick: (row: ResearchRow) => number | null,
): Map<string, number> {
  const present = rows.filter((row) => pick(row) !== null);
  const ranks = percentileRanks(
    present.map((row) => ({ id: row.pid, value: pick(row) as number })),
  );
  return new Map(rows.map((row) => [row.pid, ranks.get(row.pid) ?? 0.5]));
}

function buildRows(
  players: Map<string, Player>,
  history: CachedHistory,
  rosterPositions: string[],
  numTeams: number,
): ResearchRow[] {
  const seasons = seasonMaps(history);
  const depths = startingDepthByGroup(rosterPositions, numTeams);
  const replacements = new Map(
    DATA_SEASONS.map((season) => [
      season,
      replacementLevels(seasons.get(season) ?? new Map(), depths),
    ]),
  );
  const firstSeason = new Map<string, number>();
  for (const [season, playersInSeason] of seasons) {
    for (const pid of playersInSeason.keys()) {
      firstSeason.set(pid, Math.min(firstSeason.get(pid) ?? season, season));
    }
  }

  const allRows: ResearchRow[] = [];
  for (const snapshot of SNAPSHOT_SEASONS) {
    const current = seasons.get(snapshot) ?? new Map();
    const priorOne = seasons.get(snapshot - 1) ?? new Map();
    const priorTwo = seasons.get(snapshot - 2) ?? new Map();

    for (const group of POSITION_GROUPS) {
      const rawRows: ResearchRow[] = [];
      for (const season of current.values()) {
        if (season.group !== group || season.games < MIN_SNAPSHOT_GAMES) continue;
        const p1 = priorOne.get(season.pid);
        const p2 = priorTwo.get(season.pid);
        const age = ageAtSeason(players.get(season.pid), snapshot);

        const productionThree = weightedMean([
          { value: season.ppg, weight: 0.55 },
          ...(p1 ? [{ value: p1.ppg, weight: 0.3 }] : []),
          ...(p2 ? [{ value: p2.ppg, weight: 0.15 }] : []),
        ]);
        const priorPpg = weightedMean([
          ...(p1 ? [{ value: p1.ppg, weight: p1.games }] : []),
          ...(p2 ? [{ value: p2.ppg, weight: p2.games }] : []),
        ]);
        const legacyProduction =
          p1 || p2 ? 0.8 * season.ppg + 0.2 * priorPpg : season.ppg;
        const currentAvailabilityRaw = season.games / WEEKS;
        const availability = weightedMean([
          { value: season.games / WEEKS, weight: 0.55 },
          ...(p1 ? [{ value: p1.games / WEEKS, weight: 0.3 }] : []),
          ...(p2 ? [{ value: p2.games / WEEKS, weight: 0.15 }] : []),
        ]);
        const priorTrend = p1 ? season.ppg - p1.ppg : 0;
        const roleParts = [
          ...(season.opportunityShare !== null
            ? [{ value: clamp01(season.opportunityShare), weight: 0.6 }]
            : []),
          ...(season.snaps !== null
            ? [{ value: clamp01(season.snaps / 100), weight: 0.4 }]
            : []),
        ];
        const role = weightedMean(roleParts);
        const longevityRaw = longevity(group, age);

        rawRows.push({
          pid: season.pid,
          snapshot,
          group,
          age,
          futureOneYear: futureVorp(
            season.pid,
            group,
            snapshot,
            1,
            seasons,
            replacements,
          ),
          futureThreeYear: futureVorp(
            season.pid,
            group,
            snapshot,
            3,
            seasons,
            replacements,
          ),
          productionOne: season.ppg,
          productionThree,
          legacyProduction,
          longevityRaw,
          longevity: longevityRaw,
          young: age === null ? 0 : -age,
          role,
          roleObserved: roleParts.length > 0,
          currentAvailabilityRaw,
          availability,
          trend: priorTrend,
          efficiency: season.efficiency ?? 0,
          efficiencyObserved: season.efficiency !== null,
          legacyProxy: 0,
          outcomeOneRank: 0,
          outcomeThreeRank: 0,
        });
      }

      const productionOneRank = rankFeature(rawRows, (row) => row.productionOne);
      const productionThreeRank = rankFeature(rawRows, (row) => row.productionThree);
      const legacyProductionRank = rankFeature(rawRows, (row) => row.legacyProduction);
      const longevityRank = rankFeature(rawRows, (row) =>
        row.age === null ? null : row.longevity,
      );
      const youngRank = rankFeature(rawRows, (row) =>
        row.age === null ? null : row.young,
      );
      const roleRank = rankFeature(rawRows, (row) =>
        row.roleObserved ? row.role : null,
      );
      const availabilityRank = rankFeature(rawRows, (row) => row.availability);
      const trendRank = rankFeature(rawRows, (row) => row.trend);
      const efficiencyRank = rankFeature(rawRows, (row) =>
        row.efficiencyObserved ? row.efficiency : null,
      );
      const outcomeOneRank = rankFeature(rawRows, (row) => row.futureOneYear);
      const outcomeThreeRank = rankFeature(rawRows, (row) => row.futureThreeYear);

      for (const row of rawRows) {
        row.productionOne = productionOneRank.get(row.pid) ?? 0.5;
        row.productionThree = productionThreeRank.get(row.pid) ?? 0.5;
        row.legacyProduction = legacyProductionRank.get(row.pid) ?? 0.5;
        row.longevity = longevityRank.get(row.pid) ?? 0.5;
        row.young = youngRank.get(row.pid) ?? 0.5;
        row.role = roleRank.get(row.pid) ?? 0.5;
        row.availability = availabilityRank.get(row.pid) ?? 0.5;
        row.trend = trendRank.get(row.pid) ?? 0.5;
        row.efficiency = efficiencyRank.get(row.pid) ?? 0.5;
        row.outcomeOneRank = outcomeOneRank.get(row.pid) ?? 0.5;
        row.outcomeThreeRank = outcomeThreeRank.get(row.pid) ?? 0.5;

        const market = 0.5;
        const yearsExperience = Math.max(0, snapshot - (firstSeason.get(row.pid) ?? snapshot));
        const youthExperience = clamp01(1 - yearsExperience / 10);
        const insulation = clamp01(
          0.35 * row.longevityRaw +
            0.3 * market +
            0.2 * row.role +
            0.15 * youthExperience,
        );
        const confidence = 0.7 + 0.3 * clamp01((seasonGames(current, row.pid) - 1) / 4);
        const raw =
          0.4 * row.legacyProduction +
          0.16 * row.longevityRaw +
          0.16 * market +
          0.12 * row.role +
          0.06 * insulation +
          0.05 * row.efficiency +
          0.05 * row.currentAvailabilityRaw;
        row.legacyProxy = 0.5 + (raw - 0.5) * confidence;
      }

      allRows.push(...rawRows);
    }
  }
  return allRows;
}

function seasonGames(season: Map<string, PlayerSeason>, pid: string): number {
  return season.get(pid)?.games ?? 0;
}

function correlation(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSquared = 0;
  let ySquared = 0;
  for (let index = 0; index < xs.length; index++) {
    const x = xs[index] - xMean;
    const y = ys[index] - yMean;
    numerator += x * y;
    xSquared += x * x;
    ySquared += y * y;
  }
  return xSquared > 0 && ySquared > 0
    ? numerator / Math.sqrt(xSquared * ySquared)
    : 0;
}

function bucketed(rows: ResearchRow[]): ResearchRow[][] {
  const buckets = new Map<string, ResearchRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(key(row.snapshot, row.group));
    if (bucket) bucket.push(row);
    else buckets.set(key(row.snapshot, row.group), [row]);
  }
  return [...buckets.values()].filter((bucket) => bucket.length >= 8);
}

function macroSpearman(
  rows: ResearchRow[],
  predict: (row: ResearchRow) => number,
  outcome: 'outcomeOneRank' | 'outcomeThreeRank' = 'outcomeThreeRank',
): number {
  const correlations = bucketed(rows).map((bucket) =>
    correlation(
      bucket.map(predict),
      bucket.map((row) => row[outcome]),
    ),
  );
  return correlations.length ? mean(correlations) : 0;
}

function topQuartilePrecision(
  rows: ResearchRow[],
  predict: (row: ResearchRow) => number,
  outcome: 'outcomeOneRank' | 'outcomeThreeRank' = 'outcomeThreeRank',
): number {
  const scores: number[] = [];
  for (const bucket of bucketed(rows)) {
    const count = Math.max(1, Math.ceil(bucket.length * 0.25));
    const predicted = [...bucket]
      .sort((left, right) => predict(right) - predict(left))
      .slice(0, count);
    const actual = new Set(
      [...bucket]
        .sort((left, right) => right[outcome] - left[outcome])
        .slice(0, count)
        .map((row) => row.pid),
    );
    scores.push(predicted.filter((row) => actual.has(row.pid)).length / count);
  }
  return scores.length ? mean(scores) : 0;
}

function candidateScore(row: ResearchRow, weights: Weights): number {
  return FEATURE_NAMES.reduce(
    (score, feature) => score + row[feature] * weights[feature],
    0,
  );
}

function enumerateWeights(total: number, parts: number): number[][] {
  const combinations: number[][] = [];
  const visit = (remaining: number, values: number[]) => {
    if (values.length === parts - 1) {
      combinations.push([...values, remaining]);
      return;
    }
    for (let value = 0; value <= remaining; value++) {
      visit(remaining - value, [...values, value]);
    }
  };
  visit(total, []);
  return combinations;
}

function weightObjective(
  rows: ResearchRow[],
  weights: Weights,
  objective: WeightObjective,
): number {
  const predict = (row: ResearchRow) => candidateScore(row, weights);
  const rank = macroSpearman(rows, predict);
  return objective === 'rank'
    ? rank
    : 0.65 * rank + 0.35 * topQuartilePrecision(rows, predict);
}

function selectWeights(
  training: ResearchRow[],
  objective: WeightObjective = 'rank',
): Weights {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestWeights: Weights | null = null;

  for (const combination of enumerateWeights(10, FEATURE_NAMES.length)) {
    const weights = Object.fromEntries(
      FEATURE_NAMES.map((feature, index) => [feature, combination[index] / 10]),
    ) as Weights;
    const score = weightObjective(training, weights, objective);
    if (score > bestScore) {
      bestScore = score;
      bestWeights = weights;
    }
  }

  if (!bestWeights) throw new Error('Weight search produced no candidates');
  return bestWeights;
}

function selectWeightsByPosition(
  training: ResearchRow[],
  objective: WeightObjective,
): Map<PositionGroup, Weights> {
  return new Map(
    POSITION_GROUPS.map((group) => [
      group,
      selectWeights(
        training.filter((row) => row.group === group),
        objective,
      ),
    ]),
  );
}

function scoreWithPositionWeights(
  row: ResearchRow,
  weights: Map<PositionGroup, Weights>,
): number {
  const groupWeights = weights.get(row.group);
  return groupWeights ? candidateScore(row, groupWeights) : row.legacyProxy;
}

function rowsIn(rows: ResearchRow[], seasons: Set<number>): ResearchRow[] {
  return rows.filter((row) => seasons.has(row.snapshot));
}

function reportModel(
  label: string,
  rows: ResearchRow[],
  predict: (row: ResearchRow) => number,
): void {
  console.log(
    `${label.padEnd(25)} ${macroSpearman(rows, predict).toFixed(3).padStart(7)} ${(
      topQuartilePrecision(rows, predict) * 100
    )
      .toFixed(1)
      .padStart(9)}% ${macroSpearman(rows, predict, 'outcomeOneRank')
      .toFixed(3)
      .padStart(9)}`,
  );
}

function reportSplit(
  title: string,
  rows: ResearchRow[],
  rankWeights: Weights,
  balancedWeights: Weights,
  positionWeights: Map<PositionGroup, Weights>,
): void {
  console.log(`\n${title}`);
  console.log('Model                     3yr rho   top-25 hit   1yr rho');
  reportModel('Current production', rows, (row) => row.productionOne);
  reportModel('80/20 production blend', rows, (row) => row.legacyProduction);
  reportModel('Restored model proxy', rows, (row) => row.legacyProxy);
  reportModel('Rank-trained candidate', rows, (row) =>
    candidateScore(row, rankWeights),
  );
  reportModel('Balanced candidate', rows, (row) =>
    candidateScore(row, balancedWeights),
  );
  reportModel('Position-fit candidate', rows, (row) =>
    scoreWithPositionWeights(row, positionWeights),
  );
}

function reportByPosition(
  rows: ResearchRow[],
  weights: Map<PositionGroup, Weights>,
): void {
  console.log('\nUntouched 2022 holdout by position (3-year rank correlation)');
  console.log('Pos     n   restored   candidate   change');
  for (const group of POSITION_GROUPS) {
    const groupRows = rows.filter((row) => row.group === group);
    const restored = macroSpearman(groupRows, (row) => row.legacyProxy);
    const candidate = macroSpearman(groupRows, (row) =>
      scoreWithPositionWeights(row, weights),
    );
    console.log(
      `${group.padEnd(3)} ${String(groupRows.length).padStart(5)} ${restored
        .toFixed(3)
        .padStart(10)} ${candidate.toFixed(3).padStart(11)} ${(candidate - restored)
        .toFixed(3)
        .padStart(8)}`,
    );
  }
}

function reportAgeEvidence(rows: ResearchRow[]): void {
  console.log('\nAge signal on untouched 2022 holdout');
  console.log('Pos   longevity rho   younger rho');
  for (const group of POSITION_GROUPS) {
    const groupRows = rows.filter((row) => row.group === group);
    console.log(
      `${group.padEnd(3)} ${macroSpearman(groupRows, (row) => row.longevity)
        .toFixed(3)
        .padStart(15)} ${macroSpearman(groupRows, (row) => row.young)
        .toFixed(3)
        .padStart(13)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('Loading player dictionary and league scoring…');
  const [playerPayload, league] = await Promise.all([
    getAllPlayers(),
    getLeague(LEAGUE_ID),
  ]);
  const players = new Map<string, Player>(Object.entries(playerPayload));
  const history = await loadHistory(players);
  const rows = buildRows(
    players,
    history,
    league.roster_positions,
    league.total_rosters,
  );

  const training = rowsIn(rows, TRAIN_SEASONS);
  const validation = rowsIn(rows, VALIDATION_SEASONS);
  const holdout = rowsIn(rows, HOLDOUT_SEASONS);
  const rankWeights = selectWeights(training, 'rank');
  const balancedWeights = selectWeights(training, 'balanced');
  const positionWeights = selectWeightsByPosition(training, 'balanced');
  const knownAges = rows.filter((row) => row.age !== null).length;

  console.log(`\n${'='.repeat(76)}`);
  console.log('DYNASTY HISTORY: FUTURE CUSTOM-SCORED VALUE OVER REPLACEMENT');
  console.log('='.repeat(76));
  console.log(
    `${rows.length} observations; ${knownAges}/${rows.length} (${(
      (knownAges / rows.length) *
      100
    ).toFixed(1)}%) ages reconstructed`,
  );
  console.log(
    `${history.scoringKeys} active custom scoring keys; snapshots 2017-2022; outcomes through 2025`,
  );
  console.log(
    'Selection: train 2017-2020 only; validation 2021; untouched holdout 2022',
  );
  console.log('\nTraining-selected global weights (rank objective)');
  for (const feature of FEATURE_NAMES) {
    console.log(
      `  ${feature.padEnd(20)} ${(rankWeights[feature] * 100).toFixed(0)}%`,
    );
  }
  console.log('\nTraining-selected global weights (65% rank / 35% top-quartile objective)');
  for (const feature of FEATURE_NAMES) {
    console.log(
      `  ${feature.padEnd(20)} ${(balancedWeights[feature] * 100).toFixed(0)}%`,
    );
  }
  console.log('\nTraining-selected position weights (balanced objective)');
  for (const group of POSITION_GROUPS) {
    const weights = positionWeights.get(group)!;
    console.log(
      `  ${group}: ${FEATURE_NAMES.map(
        (feature) => `${feature} ${Math.round(weights[feature] * 100)}%`,
      ).join(', ')}`,
    );
  }

  reportSplit(
    'Training (2017-2020)',
    training,
    rankWeights,
    balancedWeights,
    positionWeights,
  );
  reportSplit(
    'Validation (2021)',
    validation,
    rankWeights,
    balancedWeights,
    positionWeights,
  );
  reportSplit(
    'Untouched holdout (2022 -> 2023-2025)',
    holdout,
    rankWeights,
    balancedWeights,
    positionWeights,
  );
  reportByPosition(holdout, positionWeights);
  reportAgeEvidence(holdout);

  console.log(
    '\nInterpretation: rho measures ranking accuracy within each position and is macro-averaged',
  );
  console.log(
    'across position/seasons. Top-25 hit rate is the share of predicted top-quartile',
  );
  console.log(
    'players who actually landed in the top quartile of future 3-year VORP.',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
