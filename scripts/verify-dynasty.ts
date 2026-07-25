/**
 * Deterministic regression checks for the dynasty value model.
 *
 * These fixtures intentionally avoid network data so failures identify model
 * behavior rather than a third-party API or changing player snapshot.
 */

import assert from 'node:assert/strict';
import { buildDynastyIndex, type SeasonPpg } from '../src/lib/dynasty';
import type { MarketEntry } from '../src/lib/market';
import { computeOptimalLineup } from '../src/lib/optimal';
import type { Player, PositionGroup } from '../src/lib/types';
import type { PlayerValue, ValueBreakdown, ValueIndex } from '../src/lib/value';

function breakdown(group: PositionGroup, ppg: number, games: number): ValueBreakdown {
  return {
    group,
    games,
    ppg,
    scheduleAdjustedPpg: ppg,
    total: ppg * games,
    last4: ppg,
    last8: ppg,
    ewma: ppg,
    forecastProjection: ppg,
    availability: 1,
    consistency: 1,
    floor: ppg,
    ceiling: ppg,
    boomRate: 0,
    bustRate: 0,
    deltaAvg: 0,
    deltaBeatRate: 0.5,
    usagePerGame: 10,
    opportunityShare: 0.5,
    recentOpportunityShare: 0.5,
    usageTrend: 0,
    efficiency: 1,
    snapPct: 80,
    recentSnapPct: 80,
    ownedPct: null,
    startedPct: null,
    gamesConfidence: 1,
    contributions: [],
  };
}

function value(pid: string, group: PositionGroup, ppg: number, games: number): PlayerValue {
  return {
    pid,
    group,
    score: 500,
    breakdown: breakdown(group, ppg, games),
  };
}

function valueIndex(values: PlayerValue[]): ValueIndex {
  return {
    byPlayer: new Map(values.map((entry) => [entry.pid, entry])),
    ppgRanks: new Map(),
    totalRanks: new Map(),
    weeklyScores: new Map(),
    seasonTotals: new Map(),
  };
}

function player(
  pid: string,
  position: PositionGroup,
  overrides: Partial<Player> = {},
): Player {
  return {
    player_id: pid,
    position,
    fantasy_positions: [position],
    active: true,
    age: 25,
    years_exp: 3,
    team: 'TST',
    depth_chart_order: 1,
    ...overrides,
  };
}

function market(value: number, draftPick = 20): MarketEntry {
  return {
    value,
    overallRank: 1,
    positionRank: 1,
    trend30Day: 0,
    redraftValue: null,
    adp: null,
    tradeFrequency: null,
    draftRound: 1,
    draftPick,
  };
}

function playerMap(players: Player[]): Map<string, Player> {
  return new Map(players.map((entry) => [entry.player_id, entry]));
}

function assertGameWeightedRecency(): void {
  const prior: SeasonPpg = new Map([
    ['hot', { ppg: 10, games: 16 }],
    ['steady', { ppg: 10, games: 16 }],
  ]);
  const index = buildDynastyIndex({
    valueIndex: valueIndex([value('hot', 'WR', 30, 1), value('steady', 'WR', 10, 16)]),
    playersById: playerMap([player('hot', 'WR'), player('steady', 'WR')]),
    priorSeasons: [prior],
    market: new Map(),
    rosterPositions: ['WR'],
    numTeams: 1,
    rosteredPlayerIds: new Set(['hot']),
    throughWeek: 1,
  });

  const projected = index.byPlayer.get('hot')?.breakdown.projectedPpg;
  assert(projected !== undefined);
  assert(
    projected > 10 && projected < 15,
    `one 30-point game should be stabilized by 16 prior games; got ${projected}`,
  );
}

function assertMarketDoesNotSetRookieIntrinsic(): void {
  const players = [
    player('starter', 'WR'),
    player('rookie-high-market', 'WR', { age: 21, years_exp: 0, depth_chart_order: 2 }),
    player('rookie-low-market', 'WR', { age: 21, years_exp: 0, depth_chart_order: 2 }),
  ];
  const markets = new Map([
    ['rookie-high-market', market(9_000, 20)],
    ['rookie-low-market', market(1_000, 20)],
  ]);
  const index = buildDynastyIndex({
    valueIndex: valueIndex([value('starter', 'WR', 18, 12)]),
    playersById: playerMap(players),
    priorSeasons: [],
    market: markets,
    rosterPositions: ['WR'],
    numTeams: 1,
    rosteredPlayerIds: new Set(['starter', 'rookie-high-market']),
    throughWeek: 12,
  });

  const high = index.byPlayer.get('rookie-high-market');
  const low = index.byPlayer.get('rookie-low-market');
  assert(high && low);
  assert.equal(
    high.score,
    low.score,
    'market price changed intrinsic value for otherwise identical rookies',
  );
  assert.notEqual(
    high.breakdown.marketScore,
    low.breakdown.marketScore,
    'separate market scores should still preserve the price difference',
  );
}

function assertCrossPositionMagnitudeSurvives(): void {
  const values = [
    value('qb-elite', 'QB', 30, 12),
    value('qb-replacement', 'QB', 18, 12),
    value('wr-elite', 'WR', 20, 12),
    value('wr-replacement', 'WR', 18, 12),
  ];
  const players = values.map((entry) => player(entry.pid, entry.group));
  const index = buildDynastyIndex({
    valueIndex: valueIndex(values),
    playersById: playerMap(players),
    priorSeasons: [],
    market: new Map(),
    rosterPositions: ['QB', 'SUPER_FLEX', 'WR'],
    numTeams: 1,
    rosteredPlayerIds: new Set(['qb-elite', 'wr-elite']),
    throughWeek: 12,
  });

  const quarterback = index.byPlayer.get('qb-elite');
  const receiver = index.byPlayer.get('wr-elite');
  assert(quarterback && receiver);
  assert(
    quarterback.breakdown.futureVorp > receiver.breakdown.futureVorp,
    'larger QB lineup advantage was lost during cross-position normalization',
  );
}

function assertIncompleteLineupTerminates(): void {
  const lineup = computeOptimalLineup(
    ['QB', 'RB', 'WR'],
    [{ pid: 'only-player', group: 'QB', points: 20 }],
  );
  assert.equal(lineup.total, 20);
  assert.equal(
    lineup.assignments.filter((assignment) => assignment.pid !== null).length,
    1,
  );
}

assertGameWeightedRecency();
assertMarketDoesNotSetRookieIntrinsic();
assertCrossPositionMagnitudeSurvives();
assertIncompleteLineupTerminates();

console.log('dynasty model regression checks passed');
