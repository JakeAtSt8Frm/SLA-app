/**
 * Matchup research: can we predict a player's *miss* against his projection?
 *
 * The projection already knows who the opponent is. So the only question worth
 * asking is whether anything we can compute — about the defence, or about the
 * player himself — explains the part of the outcome the projection got wrong.
 * That residual, `actual − projected`, is the target throughout.
 *
 * Two families of candidate are tested against it:
 *
 *   opponent  Different ways of rating a defence: raw concessions, empirical-
 *             Bayes shrinkage, prior-season carryover, a two-way offence/defence
 *             model, per-opportunity rates, and a per-scoring-category rating
 *             matched against the individual player's own production mix.
 *
 *   player    The player's own history against the projection: his shrunk bias,
 *             his boom and bust rates this season and last, his recent form
 *             relative to what he was projected for, and his role trend.
 *
 * Everything is leakage-safe: a feature for week W is built only from weeks
 * before W in that season, plus completed prior seasons. Features are
 * percentile-ranked within (season, week, position group) before scoring, so a
 * correlation here means "ranks players correctly against their peers that
 * week", which is the form the app actually consumes.
 *
 * Seasons split discovery / validation / holdout, and the holdout column is the
 * only one that should ever be believed.
 */

import {
  compileScoring,
  createScorer,
  groupForPlayer,
  hasPlayed,
  hasValidProjection,
  opportunities,
  type ScoringModel,
} from '../src/lib/scoring';
import { buildMatchupIndex } from '../src/lib/matchup';
import { getAllPlayers, getLeague, getWeekProjections, getWeekStats } from '../src/lib/sleeper';
import { mean, percentileRanks, stdev } from '../src/lib/stats';
import type { Player, PositionGroup, StatLine } from '../src/lib/types';
import { POSITION_GROUPS } from '../src/lib/types';

/** NFL stats are league-independent; the id only supplies scoring settings. */
const SCORING_LEAGUE: Record<string, string> = {
  '2020': '1122650835105759232',
  '2021': '1122650835105759232',
  '2022': '1122650835105759232',
  '2023': '1122650835105759232',
  '2024': '1122650835105759232',
  '2025': '1180280389862244352',
};

const SEASONS = ['2020', '2021', '2022', '2023', '2024', '2025'];
/** 2020 exists only to supply prior-season features for 2021. */
const TARGET_SEASONS = ['2021', '2022', '2023', '2024', '2025'];
const DISCOVERY = new Set(['2021', '2022']);
const VALIDATION = new Set(['2023', '2024']);
const HOLDOUT = new Set(['2025']);

const WEEKS = 17;
/** Week 2 onward: week 1 has no in-season history, only prior-season carryover. */
const FIRST_TARGET_WEEK = 2;
const MIN_PROJECTION = 1;

/* -------------------------------------------------------------------------- */
/* Scoring categories                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Buckets a stat key into a scoring category.
 *
 * This league pays 9 points for a sack and 10 for an interception against 1.5
 * for a tackle, so "points allowed to DL" blends three very differently priced
 * events into one number. Splitting them lets a pure pass-rusher be matched
 * against the defences that actually concede sacks.
 *
 * Order matters: `idp_tkl_loss` must be caught before the `idp_tkl` prefix.
 */
const CATEGORIES = [
  'tfl',
  'sack',
  'takeaway',
  'passdef',
  'tackle',
  'defTd',
  'pass',
  'rush',
  'rec',
  'kick',
  'other',
] as const;
type Category = (typeof CATEGORIES)[number];

function categoryOf(key: string): Category {
  if (key.startsWith('idp_tkl_loss')) return 'tfl';
  if (key.startsWith('idp_sack')) return 'sack';
  if (key.startsWith('idp_int') || key.startsWith('idp_ff') || key.startsWith('idp_fum_rec')) {
    return 'takeaway';
  }
  if (key.startsWith('idp_pass_def')) return 'passdef';
  if (key.startsWith('idp_def_td') || key.startsWith('idp_td')) return 'defTd';
  if (key.startsWith('idp_tkl') || key.startsWith('idp_solo') || key.startsWith('idp_ast')) {
    return 'tackle';
  }
  if (key.startsWith('pass_')) return 'pass';
  if (key.startsWith('rush_')) return 'rush';
  if (key === 'rec' || key.startsWith('rec_')) return 'rec';
  if (key.startsWith('fg') || key.startsWith('xp') || key.startsWith('pat')) return 'kick';
  return 'other';
}

function categoryIndex(model: ScoringModel): Category[] {
  return model.keys.map(categoryOf);
}

function pointsByCategory(
  model: ScoringModel,
  cats: Category[],
  stats: StatLine,
): Partial<Record<Category, number>> {
  const out: Partial<Record<Category, number>> = {};
  for (let i = 0; i < model.keys.length; i++) {
    const v = stats[model.keys[i]];
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) continue;
    const cat = cats[i];
    out[cat] = (out[cat] ?? 0) + v * model.multipliers[i];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

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

interface Row {
  season: string;
  week: number;
  pid: string;
  group: PositionGroup;
  team: string;
  opponent: string;
  actual: number;
  projected: number | null;
  opportunities: number;
  byCategory: Partial<Record<Category, number>>;
  /** The raw line, so `buildMatchupIndex` can be run exactly as it ships. */
  line: StatLine;
}

interface Season {
  season: string;
  rows: Row[];
  scoringModel: ScoringModel;
}

async function loadSeason(season: string, playersById: Map<string, Player>): Promise<Season> {
  const league = await getLeague(SCORING_LEAGUE[season]);
  const scoringModel = compileScoring(league.scoring_settings);
  const score = createScorer(scoringModel);
  const cats = categoryIndex(scoringModel);
  const rows: Row[] = [];

  await mapLimit(
    Array.from({ length: WEEKS }, (_, i) => i + 1),
    5,
    async (week) => {
      const [stats, projections] = await Promise.all([
        getWeekStats(season, week, 'regular').catch(() => null),
        getWeekProjections(season, week, 'regular').catch(() => null),
      ]);
      if (!stats) return;

      for (const [pid, line] of Object.entries(stats.stats)) {
        if (!hasPlayed(line)) continue;
        const group = groupForPlayer(playersById.get(pid));
        const team = stats.teams[pid];
        const opponent = stats.opponents[pid];
        if (!group || !team || !opponent) continue;

        const projLine = projections?.stats[pid];
        rows.push({
          season,
          week,
          pid,
          group,
          team,
          opponent,
          actual: score(line),
          projected: hasValidProjection(projLine) ? score(projLine) : null,
          opportunities: opportunities(group, line) ?? 0,
          byCategory: pointsByCategory(scoringModel, cats, line),
          line,
        });
      }
    },
  );

  rows.sort((a, b) => a.week - b.week);
  return { season, rows, scoringModel };
}

/* -------------------------------------------------------------------------- */
/* Defence ratings                                                             */
/* -------------------------------------------------------------------------- */

interface DefenseGameRow {
  week: number;
  defense: string;
  offense: string;
  points: number;
  opportunities: number;
  byCategory: Partial<Record<Category, number>>;
  /** The raw line, so `buildMatchupIndex` can be run exactly as it ships. */
  line: StatLine;
}

/** Collapses player-weeks into one row per (defence, week) for a group. */
function defenseGames(rows: Row[], group: PositionGroup): DefenseGameRow[] {
  const byKey = new Map<string, DefenseGameRow>();
  for (const row of rows) {
    if (row.group !== group) continue;
    const key = `${row.week}:${row.opponent}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        week: row.week,
        defense: row.opponent,
        offense: row.team,
        points: 0,
        opportunities: 0,
        byCategory: {},
      };
      byKey.set(key, entry);
    }
    entry.points += row.actual;
    entry.opportunities += row.opportunities;
    for (const cat of CATEGORIES) {
      const v = row.byCategory[cat];
      if (v) entry.byCategory[cat] = (entry.byCategory[cat] ?? 0) + v;
    }
  }
  return [...byKey.values()];
}

/**
 * Two-way additive fit: conceded = mean + offence effect + defence effect.
 *
 * The shipped model approximates this by subtracting the producing team's
 * average from each week's concession. That is a single pass and ignores the
 * fact that the offences themselves played different defences — so a defence
 * that happened to face good offences stays overrated. Alternating ridge
 * least squares solves both sides jointly and purges the schedule properly.
 * The ridge term doubles as the small-sample shrinkage.
 */
function twoWayDefenseEffects(games: DefenseGameRow[], lambda = 3): Map<string, number> {
  const grand = mean(games.map((g) => g.points));
  const offense = new Map<string, number>();
  const defense = new Map<string, number>();

  for (let iteration = 0; iteration < 25; iteration++) {
    const offSum = new Map<string, { sum: number; n: number }>();
    for (const g of games) {
      const entry = offSum.get(g.offense) ?? { sum: 0, n: 0 };
      entry.sum += g.points - grand - (defense.get(g.defense) ?? 0);
      entry.n++;
      offSum.set(g.offense, entry);
    }
    for (const [team, { sum, n }] of offSum) offense.set(team, sum / (n + lambda));

    const defSum = new Map<string, { sum: number; n: number }>();
    for (const g of games) {
      const entry = defSum.get(g.defense) ?? { sum: 0, n: 0 };
      entry.sum += g.points - grand - (offense.get(g.offense) ?? 0);
      entry.n++;
      defSum.set(g.defense, entry);
    }
    for (const [team, { sum, n }] of defSum) defense.set(team, sum / (n + lambda));
  }

  return defense;
}

/**
 * Empirical-Bayes shrinkage of a defence's mean toward the league mean.
 *
 * The weight `n / (n + k)` comes from the ratio of within-defence noise to
 * between-defence spread, estimated from the data rather than picked. With
 * sixteen games a season and thirty-two defences, a defence seen three times is
 * mostly noise and should not be trusted like one seen twelve times.
 */
function shrunkMeans(
  values: Map<string, number[]>,
): { means: Map<string, number>; k: number } {
  const all: number[] = [];
  for (const list of values.values()) all.push(...list);
  const grand = mean(all);

  const within = mean(
    [...values.values()].filter((l) => l.length > 1).map((l) => stdev(l) ** 2),
  );
  const groupMeans = [...values.values()].filter((l) => l.length > 0).map((l) => mean(l));
  const between = Math.max(stdev(groupMeans) ** 2 - within / Math.max(1, mean([...values.values()].map((l) => l.length))), 1e-6);
  const k = Math.max(0.5, Math.min(40, within / between));

  const means = new Map<string, number>();
  for (const [id, list] of values) {
    const n = list.length;
    means.set(id, n ? (mean(list) * n + grand * k) / (n + k) : grand);
  }
  return { means, k };
}

function ewma(values: number[], decay = 0.75): number {
  if (!values.length) return 0;
  let total = 0;
  let weight = 0;
  let current = 1;
  for (let i = values.length - 1; i >= 0; i--) {
    total += values[i] * current;
    weight += current;
    current *= decay;
  }
  return weight ? total / weight : 0;
}

/* -------------------------------------------------------------------------- */
/* Observation building                                                        */
/* -------------------------------------------------------------------------- */

interface Obs {
  season: string;
  week: number;
  group: PositionGroup;
  residual: number;
  [feature: string]: string | number;
}

const OPPONENT_FEATURES = [
  'defRaw',
  'defShrunk',
  'defEwma',
  'defPrior',
  'defCarry',
  'defTwoWay',
  'defPerOpp',
  'defOppVolume',
  'defCategory',
];

const PLAYER_FEATURES = [
  'playerBias',
  'playerBiasPrior',
  'playerBiasCarry',
  'playerBoomBust',
  'playerBoomBustPrior',
  'playerRatio',
  'recentVsProj',
  'usageTrend',
  'consistency',
];

const ALL_FEATURES = [...OPPONENT_FEATURES, ...PLAYER_FEATURES];

/** Per-player running history against the projection. */
interface PlayerHistory {
  residuals: number[];
  ratios: number[];
  actuals: number[];
  projections: number[];
  opportunities: number[];
  boom: number;
  bust: number;
  projected: number;
}

function summarisePlayers(rows: Row[]): Map<string, PlayerHistory> {
  const out = new Map<string, PlayerHistory>();
  for (const row of rows) {
    let h = out.get(row.pid);
    if (!h) {
      h = {
        residuals: [],
        ratios: [],
        actuals: [],
        projections: [],
        opportunities: [],
        boom: 0,
        bust: 0,
        projected: 0,
      };
      out.set(row.pid, h);
    }
    h.actuals.push(row.actual);
    h.opportunities.push(row.opportunities);
    if (row.projected !== null && row.projected >= MIN_PROJECTION) {
      h.residuals.push(row.actual - row.projected);
      h.ratios.push(row.actual / row.projected);
      h.projections.push(row.projected);
      h.projected++;
      if (row.actual >= row.projected * 1.2) h.boom++;
      else if (row.actual <= row.projected * 0.8) h.bust++;
    }
  }
  return out;
}

/** Shrunk mean toward zero — small samples must not assert a large bias. */
function shrunkMean(values: number[], prior: number): number {
  if (!values.length) return 0;
  return (values.reduce((s, v) => s + v, 0) + 0) / (values.length + prior);
}

function buildObservations(
  season: Season,
  priorSeason: Season | undefined,
): Obs[] {
  const observations: Obs[] = [];

  const priorPlayers = priorSeason ? summarisePlayers(priorSeason.rows) : new Map();

  /** Last season's category mix, used before a player has any current-season one. */
  const priorMixByPlayer = new Map<string, { total: number; byCat: Map<Category, number> }>();
  for (const row of priorSeason?.rows ?? []) {
    let entry = priorMixByPlayer.get(row.pid);
    if (!entry) {
      entry = { total: 0, byCat: new Map() };
      priorMixByPlayer.set(row.pid, entry);
    }
    for (const cat of CATEGORIES) {
      const v = row.byCategory[cat];
      if (v && v > 0) {
        entry.byCat.set(cat, (entry.byCat.get(cat) ?? 0) + v);
        entry.total += v;
      }
    }
  }
  // Prior-season defence means, per group.
  const priorDefense = new Map<PositionGroup, Map<string, number>>();
  if (priorSeason) {
    for (const group of POSITION_GROUPS) {
      const games = defenseGames(priorSeason.rows, group);
      const byDefense = new Map<string, number[]>();
      for (const g of games) {
        const list = byDefense.get(g.defense);
        if (list) list.push(g.points);
        else byDefense.set(g.defense, [g.points]);
      }
      priorDefense.set(group, shrunkMeans(byDefense).means);
    }
  }

  for (let targetWeek = FIRST_TARGET_WEEK; targetWeek <= WEEKS; targetWeek++) {
    const history = season.rows.filter((r) => r.week < targetWeek);
    const targets = season.rows.filter(
      (r) => r.week === targetWeek && r.projected !== null && r.projected >= MIN_PROJECTION,
    );
    if (!targets.length) continue;

    const players = summarisePlayers(history);

    // Per-player category mix, accumulated once for the whole week rather than
    // rescanned per target — the naive version is O(targets x history).
    const mixByPlayer = new Map<string, { total: number; byCat: Map<Category, number> }>();
    for (const row of history) {
      let entry = mixByPlayer.get(row.pid);
      if (!entry) {
        entry = { total: 0, byCat: new Map() };
        mixByPlayer.set(row.pid, entry);
      }
      for (const cat of CATEGORIES) {
        const v = row.byCategory[cat];
        if (v && v > 0) {
          entry.byCat.set(cat, (entry.byCat.get(cat) ?? 0) + v);
          entry.total += v;
        }
      }
    }

    // ---- defence ratings, per position group ------------------------------
    const defRaw = new Map<PositionGroup, Map<string, number>>();
    const defShrunk = new Map<PositionGroup, Map<string, number>>();
    const defEwma = new Map<PositionGroup, Map<string, number>>();
    const defTwoWay = new Map<PositionGroup, Map<string, number>>();
    const defPerOpp = new Map<PositionGroup, Map<string, number>>();
    const defOppVolume = new Map<PositionGroup, Map<string, number>>();
    const defCategory = new Map<PositionGroup, Map<string, Map<Category, number>>>();

    for (const group of POSITION_GROUPS) {
      const games = defenseGames(history, group);
      if (!games.length) continue;

      const points = new Map<string, number[]>();
      const perOpp = new Map<string, number[]>();
      const byCat = new Map<string, Map<Category, number[]>>();

      for (const g of games) {
        (points.get(g.defense) ?? points.set(g.defense, []).get(g.defense)!).push(g.points);
        (perOpp.get(g.defense) ?? perOpp.set(g.defense, []).get(g.defense)!).push(
          g.points / Math.max(1, g.opportunities),
        );
        let cats = byCat.get(g.defense);
        if (!cats) {
          cats = new Map();
          byCat.set(g.defense, cats);
        }
        for (const cat of CATEGORIES) {
          const list = cats.get(cat) ?? cats.set(cat, []).get(cat)!;
          list.push(g.byCategory[cat] ?? 0);
        }
      }

      defRaw.set(group, new Map([...points].map(([d, l]) => [d, mean(l)])));
      defShrunk.set(group, shrunkMeans(points).means);
      defEwma.set(group, new Map([...points].map(([d, l]) => [d, ewma(l)])));
      defPerOpp.set(group, shrunkMeans(perOpp).means);
      defOppVolume.set(
        group,
        shrunkMeans(
          new Map(
            [...points.keys()].map((d) => [
              d,
              games.filter((g) => g.defense === d).map((g) => g.opportunities),
            ]),
          ),
        ).means,
      );
      defTwoWay.set(group, twoWayDefenseEffects(games));

      // Category ratings are percentiled across defences so they combine.
      const catRatings = new Map<string, Map<Category, number>>();
      for (const cat of CATEGORIES) {
        const entries = [...byCat].map(([d, cats]) => ({ id: d, value: mean(cats.get(cat) ?? [0]) }));
        const ranks = percentileRanks(entries);
        for (const [d] of byCat) {
          const m = catRatings.get(d) ?? catRatings.set(d, new Map()).get(d)!;
          m.set(cat, ranks.get(d) ?? 0.5);
        }
      }
      defCategory.set(group, catRatings);
    }

    // ---- emit one observation per target player ---------------------------
    for (const target of targets) {
      const projected = target.projected!;
      const own = players.get(target.pid);
      const prior = priorPlayers.get(target.pid) as PlayerHistory | undefined;
      // Two prior games is the minimum that makes a player feature mean anything.
      const hasHistory = (own?.actuals.length ?? 0) >= 2;

      const group = target.group;
      const d = target.opponent;

      // Player's own category mix, from this season falling back to last.
      const mixEntry =
        (hasHistory ? mixByPlayer.get(target.pid) : undefined) ??
        priorMixByPlayer.get(target.pid);
      const mix = mixEntry?.byCat ?? new Map<Category, number>();
      const mixTotal = mixEntry?.total ?? 0;

      const catRatings = defCategory.get(group)?.get(d);
      let categoryScore = 0.5;
      if (catRatings && mixTotal > 0) {
        let acc = 0;
        for (const [cat, points] of mix) acc += (points / mixTotal) * (catRatings.get(cat) ?? 0.5);
        categoryScore = acc;
      }

      const shrunkBias = own ? shrunkMean(own.residuals, 6) : 0;
      const priorBias = prior ? shrunkMean(prior.residuals, 6) : 0;

      const recentProjections = own?.projections.slice(-3) ?? [];
      const recentActuals = own?.actuals.slice(-3) ?? [];

      observations.push({
        season: season.season,
        week: targetWeek,
        group,
        residual: target.actual - projected,

        // ---- opponent ----
        defRaw: defRaw.get(group)?.get(d) ?? 0,
        defShrunk: defShrunk.get(group)?.get(d) ?? 0,
        defEwma: defEwma.get(group)?.get(d) ?? 0,
        defPrior: priorDefense.get(group)?.get(d) ?? 0,
        defCarry:
          (defShrunk.get(group)?.get(d) ?? 0) * Math.min(1, (targetWeek - 1) / 8) +
          (priorDefense.get(group)?.get(d) ?? 0) * (1 - Math.min(1, (targetWeek - 1) / 8)),
        defTwoWay: defTwoWay.get(group)?.get(d) ?? 0,
        defPerOpp: defPerOpp.get(group)?.get(d) ?? 0,
        defOppVolume: defOppVolume.get(group)?.get(d) ?? 0,
        defCategory: categoryScore,

        // ---- player ----
        playerBias: hasHistory ? shrunkBias : 0,
        playerBiasPrior: priorBias,
        playerBiasCarry: hasHistory ? shrunkBias * 0.6 + priorBias * 0.4 : priorBias,
        playerBoomBust:
          own && own.projected > 0 ? (own.boom - own.bust) / (own.projected + 4) : 0,
        playerBoomBustPrior:
          prior && prior.projected > 0 ? (prior.boom - prior.bust) / (prior.projected + 4) : 0,
        playerRatio: own && own.ratios.length ? shrunkMean(own.ratios.map((r) => r - 1), 6) : 0,
        recentVsProj:
          recentProjections.length && recentActuals.length
            ? mean(recentActuals) - mean(recentProjections)
            : 0,
        usageTrend:
          own && own.opportunities.length >= 3
            ? mean(own.opportunities.slice(-2)) - mean(own.opportunities)
            : 0,
        consistency:
          own && own.actuals.length >= 3
            ? 1 - Math.min(stdev(own.actuals) / Math.max(mean(own.actuals), 1), 1)
            : 0.5,
      });
    }
  }

  return observations;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/** Percentile-ranks every feature and the target within (season, week, group). */
function rankWithinWeek(rows: Obs[], features: string[]): Obs[] {
  const buckets = new Map<string, Obs[]>();
  for (const row of rows) {
    const key = `${row.season}:${row.week}:${row.group}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const out: Obs[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 4) continue;
    const targetRanks = percentileRanks(
      bucket.map((row, i) => ({ id: String(i), value: row.residual })),
    );
    const featureRanks = new Map(
      features.map((f) => [
        f,
        percentileRanks(bucket.map((row, i) => ({ id: String(i), value: Number(row[f]) }))),
      ]),
    );

    bucket.forEach((row, i) => {
      const ranked: Obs = {
        season: row.season,
        week: row.week,
        group: row.group,
        residual: targetRanks.get(String(i)) ?? 0.5,
      };
      for (const f of features) ranked[f] = featureRanks.get(f)?.get(String(i)) ?? 0.5;
      out.push(ranked);
    });
  }
  return out;
}

function corr(rows: Obs[], feature: string): number {
  if (rows.length < 3) return 0;
  const xs = rows.map((r) => Number(r[feature]));
  const ys = rows.map((r) => r.residual);
  const xm = mean(xs);
  const ym = mean(ys);
  let num = 0;
  let xs2 = 0;
  let ys2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - xm;
    const b = ys[i] - ym;
    num += a * b;
    xs2 += a * a;
    ys2 += b * b;
  }
  return xs2 > 0 && ys2 > 0 ? num / Math.sqrt(xs2 * ys2) : 0;
}

/** Ridge regression of the ranked target on ranked features. */
function fitRidge(rows: Obs[], features: string[], lambda = 1): number[] {
  const n = features.length;
  const xtx: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const xty = new Array(n).fill(0);

  for (const row of rows) {
    const x = features.map((f) => Number(row[f]) - 0.5);
    const y = row.residual - 0.5;
    for (let i = 0; i < n; i++) {
      xty[i] += x[i] * y;
      for (let j = 0; j < n; j++) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < n; i++) xtx[i][i] += lambda * rows.length * 0.01;

  // Gauss-Jordan.
  const a = xtx.map((r, i) => [...r, xty[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let c = col; c <= n; c++) a[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((r) => r[n]);
}

function scoreModel(rows: Obs[], features: string[], weights: number[]): number {
  const scored = rows.map((row) => ({
    ...row,
    fitted: features.reduce((s, f, i) => s + weights[i] * (Number(row[f]) - 0.5), 0),
  }));
  return corr(scored, 'fitted');
}

function pad(text: string, width: number) {
  return text.padEnd(width);
}
function num(value: number, width = 9, digits = 4) {
  return value.toFixed(digits).padStart(width);
}

/* -------------------------------------------------------------------------- */

async function main() {
  const playersRaw = await getAllPlayers();
  const playersById = new Map<string, Player>(Object.entries(playersRaw));

  console.log('Loading seasons…');
  const seasons = new Map<string, Season>();
  for (const season of SEASONS) {
    seasons.set(season, await loadSeason(season, playersById));
    console.log(`  ${season}: ${seasons.get(season)!.rows.length} player-weeks`);
  }

  const all: Obs[] = [];
  for (const season of TARGET_SEASONS) {
    const built = buildObservations(
      seasons.get(season)!,
      seasons.get(String(Number(season) - 1)),
    );
    all.push(...built);
  }

  const ranked = rankWithinWeek(all, ALL_FEATURES);
  const discovery = ranked.filter((r) => DISCOVERY.has(String(r.season)));
  const validation = ranked.filter((r) => VALIDATION.has(String(r.season)));
  const holdout = ranked.filter((r) => HOLDOUT.has(String(r.season)));

  console.log(
    `\nObservations: ${ranked.length} ` +
      `(${discovery.length} discovery / ${validation.length} validation / ${holdout.length} holdout)`,
  );
  console.log('Target: actual − projected, rank-normalised within season/week/position.\n');

  console.log('='.repeat(78));
  console.log('SINGLE SIGNALS');
  console.log('='.repeat(78));
  console.log(`${pad('signal', 24)}${pad('discovery', 11)}${pad('validation', 12)}holdout`);
  for (const family of [OPPONENT_FEATURES, PLAYER_FEATURES]) {
    console.log('  ' + '-'.repeat(60));
    for (const f of family) {
      console.log(
        `${pad(f, 24)}${num(corr(discovery, f), 10)}${num(corr(validation, f), 12)}${num(corr(holdout, f), 10)}`,
      );
    }
  }

  /* ---- the shipped blend, against alternatives -------------------------- */

  console.log(`\n${'='.repeat(78)}`);
  console.log('DEFENCE BLEND — the shipped 0.6 adjusted / 0.4 opportunity, vs candidates');
  console.log('='.repeat(78));
  console.log(`${pad('blend', 34)}${pad('discovery', 11)}${pad('validation', 12)}holdout`);

  const blends: Array<{ name: string; parts: Array<[string, number]> }> = [];
  for (const base of ['defShrunk', 'defTwoWay'] as const) {
    for (const oppWeight of [0, 0.2, 0.4]) {
      blends.push({
        name: `${base} ${(1 - oppWeight).toFixed(1)} / volume ${oppWeight.toFixed(1)}`,
        parts: [
          [base, 1 - oppWeight],
          ['defOppVolume', oppWeight],
        ],
      });
    }
  }
  blends.push({
    name: 'defTwoWay 0.7 / category 0.3',
    parts: [
      ['defTwoWay', 0.7],
      ['defCategory', 0.3],
    ],
  });
  blends.push({
    name: 'defTwoWay 0.6 / category 0.2 / prior 0.2',
    parts: [
      ['defTwoWay', 0.6],
      ['defCategory', 0.2],
      ['defPrior', 0.2],
    ],
  });

  const blendCorr = (rows: Obs[], parts: Array<[string, number]>) =>
    corr(
      rows.map((row) => ({
        ...row,
        blend: parts.reduce((s, [f, w]) => s + w * Number(row[f]), 0),
      })),
      'blend',
    );

  for (const blend of blends) {
    console.log(
      `${pad(blend.name, 34)}${num(blendCorr(discovery, blend.parts), 10)}` +
        `${num(blendCorr(validation, blend.parts), 12)}${num(blendCorr(holdout, blend.parts), 10)}`,
    );
  }

  console.log('\nBy position — best defence blend vs the shipped one, holdout:');
  console.log(`${pad('group', 7)}${pad('n', 7)}${pad('shipped', 11)}${pad('twoWay+cat', 12)}delta`);
  const shipped: Array<[string, number]> = [
    ['defShrunk', 0.6],
    ['defOppVolume', 0.4],
  ];
  const candidate: Array<[string, number]> = [
    ['defTwoWay', 0.7],
    ['defCategory', 0.3],
  ];
  for (const group of POSITION_GROUPS) {
    const rows = holdout.filter((r) => r.group === group);
    if (rows.length < 50) continue;
    const a = blendCorr(rows, shipped);
    const b = blendCorr(rows, candidate);
    console.log(
      `${pad(group, 7)}${pad(String(rows.length), 7)}${num(a, 10)}${num(b, 12)}${num(b - a, 10)}`,
    );
  }

  /* ---- per-position blend search ---------------------------------------- */

  console.log(`\n${'='.repeat(78)}`);
  console.log('PER-POSITION CHIP — best defence blend, chosen on validation');
  console.log('='.repeat(78));

  const CHIP_SIGNALS = ['defTwoWay', 'defOppVolume', 'defCategory', 'defPrior'] as const;
  /** All weight vectors over the signals in steps of 0.2, summing to 1. */
  const grid: number[][] = [];
  for (let a = 0; a <= 5; a++) {
    for (let b = 0; b + a <= 5; b++) {
      for (let c = 0; c + b + a <= 5; c++) {
        grid.push([a / 5, b / 5, c / 5, (5 - a - b - c) / 5]);
      }
    }
  }

  console.log(
    `${pad('group', 7)}${pad('shipped', 10)}${pad('best', 9)}${pad('gain', 9)}weights ` +
      `(${CHIP_SIGNALS.join(' / ')})`,
  );

  const chipWeights = new Map<PositionGroup, number[]>();
  for (const group of POSITION_GROUPS) {
    const tuneRows = validation.filter((r) => r.group === group);
    const testRows = holdout.filter((r) => r.group === group);
    if (tuneRows.length < 200 || testRows.length < 50) continue;

    let best = grid[0];
    let bestScore = -Infinity;
    for (const weights of grid) {
      const parts = CHIP_SIGNALS.map((s, i) => [s, weights[i]] as [string, number]);
      const score = blendCorr(tuneRows, parts);
      if (score > bestScore) {
        bestScore = score;
        best = weights;
      }
    }
    chipWeights.set(group, best);

    const shippedScore = blendCorr(testRows, shipped);
    const bestHoldout = blendCorr(
      testRows,
      CHIP_SIGNALS.map((s, i) => [s, best[i]] as [string, number]),
    );

    console.log(
      `${pad(group, 7)}${num(shippedScore, 9)}${num(bestHoldout, 9)}${num(bestHoldout - shippedScore, 9)}  ` +
        best.map((w) => w.toFixed(1)).join(' / '),
    );
  }

  /* ---- the real shipped code path, not a research proxy ------------------ */

  console.log(`\n${'='.repeat(78)}`);
  console.log('SHIPPED CHIP — buildMatchupIndex() itself, on the holdout season');
  console.log('='.repeat(78));

  {
    const season = seasons.get('2025')!;
    const rows: Obs[] = [];

    for (let targetWeek = FIRST_TARGET_WEEK; targetWeek <= WEEKS; targetWeek++) {
      const historyStats = new Map<number, Record<string, StatLine>>();
      const historyOpponents = new Map<number, Record<string, string>>();
      const historyTeams = new Map<number, Record<string, string>>();
      for (let week = 1; week < targetWeek; week++) {
        const stats: Record<string, StatLine> = {};
        const opponents: Record<string, string> = {};
        const teams: Record<string, string> = {};
        for (const row of season.rows) {
          if (row.week !== week) continue;
          stats[row.pid] = row.line;
          opponents[row.pid] = row.opponent;
          teams[row.pid] = row.team;
        }
        historyStats.set(week, stats);
        historyOpponents.set(week, opponents);
        historyTeams.set(week, teams);
      }

      const index = buildMatchupIndex({
        scoringModel: season.scoringModel,
        playersById,
        weekStats: historyStats,
        weekOpponents: historyOpponents,
        weekTeams: historyTeams,
        throughWeek: targetWeek - 1,
      });

      for (const target of season.rows) {
        if (target.week !== targetWeek) continue;
        if (target.projected === null || target.projected < MIN_PROJECTION) continue;
        const entry = index.get(target.group, target.opponent);
        rows.push({
          season: '2025',
          week: targetWeek,
          group: target.group,
          residual: target.actual - target.projected,
          shippedChip: entry?.score ?? 50,
        });
      }
    }

    const ranked = rankWithinWeek(rows, ['shippedChip']);
    console.log(
      `  buildMatchupIndex().get().score   ${num(corr(ranked, 'shippedChip'), 9)}   n=${ranked.length}`,
    );
    console.log(
      `  research proxy (twoWay .6/vol .4) ${num(blendCorr(holdout, [['defTwoWay', 0.6], ['defOppVolume', 0.4]]), 9)}`,
    );
    console.log(
      '  The two should land close — a gap means the shipped code and the\n' +
        '  researched model have drifted apart.',
    );
    console.log(`\n  ${pad('group', 7)}${pad('n', 8)}shipped chip`);
    for (const group of POSITION_GROUPS) {
      const groupRows = ranked.filter((r) => r.group === group);
      if (groupRows.length < 50) continue;
      console.log(
        `  ${pad(group, 7)}${pad(String(groupRows.length), 8)}${num(corr(groupRows, 'shippedChip'), 9)}`,
      );
    }
  }

  /* ---- read down a roster column, not across a position ------------------ */

  console.log(`\n${'='.repeat(78)}`);
  console.log('CROSS-POSITION CHIP — does scaling by position influence help?');
  console.log('='.repeat(78));
  console.log(
    'The chip is displayed in one column down a 21-man lineup, so a 70 beside a\n' +
      'quarterback and a 70 beside a defensive back are read as the same claim.\n' +
      'Ranked within week across ALL positions, which is how a manager sees it.',
  );

  /*
   * Influence per position, normalised so the strongest reads 1. Taken from the
   * within-position holdout correlations, which are stable across splits.
   */
  const INFLUENCE: Record<string, number> = {
    QB: 1,
    K: 0.65,
    DL: 0.45,
    TE: 0.3,
    WR: 0.2,
    RB: 0.15,
    DB: 0,
    LB: 0,
  };

  /** Ranks the target within (season, week) across every position at once. */
  function rankAcrossPositions(rows: Obs[]): Obs[] {
    const buckets = new Map<string, Obs[]>();
    for (const row of rows) {
      const key = `${row.season}:${row.week}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(row);
      else buckets.set(key, [row]);
    }

    const out: Obs[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.length < 20) continue;
      const targetRanks = percentileRanks(
        bucket.map((row, i) => ({ id: String(i), value: row.residual })),
      );
      // The chip itself: the shipped blend, already a within-position percentile.
      const chipRanks = percentileRanks(
        bucket.map((row, i) => ({
          id: String(i),
          value: 0.6 * Number(row.defTwoWay) + 0.4 * Number(row.defOppVolume),
        })),
      );

      bucket.forEach((row, i) => {
        const raw = chipRanks.get(String(i)) ?? 0.5;
        const influence = INFLUENCE[String(row.group)] ?? 0.5;
        out.push({
          season: row.season,
          week: row.week,
          group: row.group,
          residual: targetRanks.get(String(i)) ?? 0.5,
          chipRaw: raw,
          chipScaled: 0.5 + influence * (raw - 0.5),
        });
      });
    }
    return out;
  }

  for (const [label, rows] of [
    ['validation', [...all.filter((r) => VALIDATION.has(r.season))]],
    ['holdout', [...all.filter((r) => HOLDOUT.has(r.season))]],
  ] as const) {
    const ranked = rankAcrossPositions(rows);
    console.log(
      `\n  ${pad(label, 12)}n=${ranked.length}` +
        `\n    ${pad('chip as shipped', 22)}${num(corr(ranked, 'chipRaw'), 9)}` +
        `\n    ${pad('scaled by influence', 22)}${num(corr(ranked, 'chipScaled'), 9)}`,
    );
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('COMBINED MODELS — fit on discovery+validation, scored on holdout');
  console.log('='.repeat(78));

  const train = [...discovery, ...validation];
  const combos: Array<{ name: string; features: string[] }> = [
    { name: 'opponent only', features: OPPONENT_FEATURES },
    { name: 'player only', features: PLAYER_FEATURES },
    { name: 'everything', features: ALL_FEATURES },
  ];

  for (const combo of combos) {
    const weights = fitRidge(train, combo.features, 1);
    console.log(
      `\n${combo.name}: train ${num(scoreModel(train, combo.features, weights), 7)}  ` +
        `holdout ${num(scoreModel(holdout, combo.features, weights), 7)}`,
    );
    combo.features
      .map((f, i) => ({ f, w: weights[i] }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .forEach(({ f, w }) => console.log(`    ${pad(f, 24)}${num(w, 9, 3)}`));
  }

  /* ---- per-position models --------------------------------------------- */

  console.log(`\n${'='.repeat(78)}`);
  console.log('PER-POSITION MODELS — fit per group, scored on holdout');
  console.log('='.repeat(78));
  console.log(
    `${pad('group', 7)}${pad('n', 7)}${pad('opponent', 11)}${pad('player', 10)}${pad('both', 10)}best`,
  );

  const perGroupFeatures = new Map<PositionGroup, string[]>();
  for (const group of POSITION_GROUPS) {
    const trainRows = train.filter((r) => r.group === group);
    const testRows = holdout.filter((r) => r.group === group);
    if (trainRows.length < 200 || testRows.length < 50) continue;

    const opponentWeights = fitRidge(trainRows, OPPONENT_FEATURES, 1);
    const playerWeights = fitRidge(trainRows, PLAYER_FEATURES, 1);
    const bothWeights = fitRidge(trainRows, ALL_FEATURES, 1);

    const opponentScore = scoreModel(testRows, OPPONENT_FEATURES, opponentWeights);
    const playerScore = scoreModel(testRows, PLAYER_FEATURES, playerWeights);
    const bothScore = scoreModel(testRows, ALL_FEATURES, bothWeights);

    const best = Math.max(opponentScore, playerScore, bothScore);
    const label =
      best === bothScore ? 'both' : best === playerScore ? 'player' : 'opponent';
    perGroupFeatures.set(
      group,
      best === bothScore ? ALL_FEATURES : best === playerScore ? PLAYER_FEATURES : OPPONENT_FEATURES,
    );

    console.log(
      `${pad(group, 7)}${pad(String(testRows.length), 7)}` +
        `${num(opponentScore, 10)} ${num(playerScore, 9)} ${num(bothScore, 9)}  ${label}`,
    );
  }

  /* ---- what it is worth in points --------------------------------------- */

  console.log(`\n${'='.repeat(78)}`);
  console.log('IN POINTS — does correcting the projection actually beat it?');
  console.log('='.repeat(78));

  /*
   * Three-way split, because the correction needs two things chosen and one
   * thing tested. Coefficients are fit on discovery; how far to trust them —
   * the damping factor — is chosen on validation; holdout is only ever read.
   *
   * The damping matters more than it looks. A model can rank players correctly
   * and still lose on MAE by being too confident about *how far* off the
   * projection is, which is exactly what the first run showed for DL: a 0.25
   * rank correlation alongside a 1.2% MAE regression.
   */
  const rawFit = all.filter((r) => DISCOVERY.has(r.season));
  const rawTune = all.filter((r) => VALIDATION.has(r.season));
  const rawHold = all.filter((r) => HOLDOUT.has(r.season));
  const DAMPING = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1];
  const chosenDamping = new Map<PositionGroup, number>();

  /** z-scores features on train statistics so ridge sees comparable scales. */
  function standardiser(rows: Obs[], features: string[]) {
    const stats = features.map((f) => {
      const values = rows.map((r) => Number(r[f]));
      const m = mean(values);
      const s = stdev(values) || 1;
      return { m, s };
    });
    return (row: Obs) => features.map((f, i) => (Number(row[f]) - stats[i].m) / stats[i].s);
  }

  console.log(
    `${pad('group', 7)}${pad('n', 7)}${pad('damping', 9)}${pad('proj MAE', 11)}${pad('corrected', 11)}gain`,
  );

  let totalBase = 0;
  let totalFitted = 0;
  let totalN = 0;

  for (const group of POSITION_GROUPS) {
    const trainRows = rawFit.filter((r) => r.group === group);
    const tuneRows = rawTune.filter((r) => r.group === group);
    const testRows = rawHold.filter((r) => r.group === group);
    if (trainRows.length < 200 || testRows.length < 50) continue;

    const features = perGroupFeatures.get(group) ?? ALL_FEATURES;
    const project = standardiser(trainRows, features);

    // Ridge on standardised features against the raw residual, in points.
    const n = features.length;
    const xtx: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const xty = new Array(n).fill(0);
    for (const row of trainRows) {
      const x = project(row);
      for (let i = 0; i < n; i++) {
        xty[i] += x[i] * row.residual;
        for (let j = 0; j < n; j++) xtx[i][j] += x[i] * x[j];
      }
    }
    for (let i = 0; i < n; i++) xtx[i][i] += trainRows.length * 0.05;

    const a = xtx.map((r, i) => [...r, xty[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      }
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const p = a[col][col];
      if (Math.abs(p) < 1e-12) continue;
      for (let c = col; c <= n; c++) a[col][c] /= p;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = a[r][col];
        for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
      }
    }
    const weights = a.map((r) => r[n]);

    const bias = mean(trainRows.map((r) => r.residual));
    const predict = (row: Obs, damping: number) => {
      const x = project(row);
      return damping * (bias + weights.reduce((s, w, i) => s + w * x[i], 0));
    };

    // Choose how far to trust the correction, on validation only.
    let damping = 0;
    let bestError = Infinity;
    for (const candidate of DAMPING) {
      const error = mean(tuneRows.map((r) => Math.abs(r.residual - predict(r, candidate))));
      if (error < bestError) {
        bestError = error;
        damping = candidate;
      }
    }
    chosenDamping.set(group, damping);

    let baseError = 0;
    let fittedError = 0;
    for (const row of testRows) {
      baseError += Math.abs(row.residual);
      fittedError += Math.abs(row.residual - predict(row, damping));
    }

    totalBase += baseError;
    totalFitted += fittedError;
    totalN += testRows.length;

    const baseMae = baseError / testRows.length;
    const fittedMae = fittedError / testRows.length;
    console.log(
      `${pad(group, 7)}${pad(String(testRows.length), 7)}${pad(damping.toFixed(2), 9)}` +
        `${num(baseMae, 10, 3)} ${num(fittedMae, 10, 3)} ` +
        `${(((baseMae - fittedMae) / baseMae) * 100).toFixed(1)}%`,
    );
  }

  console.log(
    `${pad('ALL', 7)}${pad(String(totalN), 7)}${pad('', 9)}${num(totalBase / totalN, 10, 3)} ` +
      `${num(totalFitted / totalN, 10, 3)} ` +
      `${((((totalBase - totalFitted) / totalBase) * 100)).toFixed(1)}%`,
  );

  /* ---- the exact formula worth shipping --------------------------------- */

  console.log(`\n${'='.repeat(78)}`);
  console.log('SHIPPABLE FORM — one blended per-player bias, damped per position');
  console.log('='.repeat(78));
  console.log(
    'correction = damping x (w x season bias + (1-w) x recent-3 bias); w and damping picked on validation',
  );
  console.log(
    `\n${pad('group', 7)}${pad('n', 7)}${pad('w', 7)}${pad('damping', 9)}` +
      `${pad('proj MAE', 11)}${pad('corrected', 11)}gain`,
  );

  let simpleBase = 0;
  let simpleFitted = 0;
  let simpleN = 0;
  const shippable = new Map<PositionGroup, { w: number; damping: number }>();

  for (const group of POSITION_GROUPS) {
    const tuneRows = rawTune.filter((r) => r.group === group);
    const testRows = rawHold.filter((r) => r.group === group);
    if (tuneRows.length < 200 || testRows.length < 50) continue;

    const predict = (row: Obs, w: number, damping: number) =>
      damping * (w * Number(row.playerBias) + (1 - w) * Number(row.recentVsProj));

    let bestW = 0;
    let bestDamping = 0;
    let bestError = mean(tuneRows.map((r) => Math.abs(r.residual)));
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      for (const damping of DAMPING) {
        const error = mean(tuneRows.map((r) => Math.abs(r.residual - predict(r, w, damping))));
        if (error < bestError) {
          bestError = error;
          bestW = w;
          bestDamping = damping;
        }
      }
    }
    shippable.set(group, { w: bestW, damping: bestDamping });

    let baseError = 0;
    let fittedError = 0;
    for (const row of testRows) {
      baseError += Math.abs(row.residual);
      fittedError += Math.abs(row.residual - predict(row, bestW, bestDamping));
    }
    simpleBase += baseError;
    simpleFitted += fittedError;
    simpleN += testRows.length;

    const baseMae = baseError / testRows.length;
    const fittedMae = fittedError / testRows.length;
    console.log(
      `${pad(group, 7)}${pad(String(testRows.length), 7)}${pad(bestW.toFixed(2), 7)}` +
        `${pad(bestDamping.toFixed(2), 9)}${num(baseMae, 10, 3)} ${num(fittedMae, 10, 3)} ` +
        `${(((baseMae - fittedMae) / baseMae) * 100).toFixed(1)}%`,
    );
  }

  console.log(
    `${pad('ALL', 7)}${pad(String(simpleN), 7)}${pad('', 16)}${num(simpleBase / simpleN, 10, 3)} ` +
      `${num(simpleFitted / simpleN, 10, 3)} ` +
      `${(((simpleBase - simpleFitted) / simpleBase) * 100).toFixed(1)}%`,
  );

  console.log('\nConstants for the app:');
  for (const [group, { w, damping }] of shippable) {
    console.log(`  ${pad(group, 5)} { seasonWeight: ${w}, damping: ${damping} },`);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('BY POSITION — holdout correlation');
  console.log('='.repeat(78));
  const headline = ['defShrunk', 'defTwoWay', 'defCategory', 'playerBiasCarry', 'playerBoomBust'];
  console.log(`${pad('group', 7)}${pad('n', 8)}${headline.map((h) => pad(h, 17)).join('')}`);
  for (const group of POSITION_GROUPS) {
    const rows = holdout.filter((r) => r.group === group);
    if (rows.length < 50) continue;
    console.log(
      `${pad(group, 7)}${pad(String(rows.length), 8)}` +
        headline.map((h) => pad(num(corr(rows, h), 8), 17)).join(''),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
