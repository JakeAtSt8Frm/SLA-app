/**
 * Scoring parity harness.
 *
 * Ground truth: Sleeper's /matchups/{week} endpoint returns `players_points`,
 * which Sleeper computes server-side using this league's own scoring_settings.
 * If our engine is correct, our score for a player-week must equal that number.
 *
 * This is a stronger check than diffing against the old app — it validates
 * against the platform of record rather than against a previous implementation
 * that might itself have been wrong.
 *
 * Run: npx tsx scripts/verify-scoring.ts
 */

import { compileScoring, createScorer, hasPlayed, groupForPlayer } from '../src/lib/scoring';
import { buildValueIndex } from '../src/lib/value';
import { buildMatchupIndex } from '../src/lib/matchup';
import { computeOptimalLineup, starterSlots } from '../src/lib/optimal';
import {
  getAllPlayers,
  getLeague,
  getMatchups,
  getRosters,
  getWeekProjections,
  getWeekStats,
} from '../src/lib/sleeper';
import type { Player, StatLine } from '../src/lib/types';

const LEAGUE_ID = '1180280389862244352'; // 2025
const SEASON = '2025';
const WEEKS = 17;

function fmt(n: number, w = 8) {
  return n.toFixed(2).padStart(w);
}

async function main() {
  console.log('Fetching league…');
  const league = await getLeague(LEAGUE_ID);
  console.log(`  ${league.name} (${league.season}) — ${league.total_rosters} teams`);

  const model = compileScoring(league.scoring_settings);
  console.log(`  ${model.keys.length} active scoring keys (of ${Object.keys(league.scoring_settings).length} declared)`);

  const score = createScorer(model);

  console.log('Fetching players…');
  const playersRaw = await getAllPlayers();
  const playersById = new Map<string, Player>(Object.entries(playersRaw));
  console.log(`  ${playersById.size} players`);

  const rosters = await getRosters(LEAGUE_ID);

  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProj = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();

  // ---- Parity check: our score vs Sleeper's players_points ------------------
  let compared = 0;
  let mismatches = 0;
  let worstDelta = 0;
  let worstDetail = '';
  const mismatchSamples: string[] = [];

  for (let week = 1; week <= WEEKS; week++) {
    process.stdout.write(`\rWeek ${week}/${WEEKS}…    `);

    const [stats, proj, matchups] = await Promise.all([
      getWeekStats(SEASON, week, 'regular'),
      getWeekProjections(SEASON, week, 'regular'),
      getMatchups(LEAGUE_ID, week),
    ]);

    weekStats.set(week, stats.stats);
    weekProj.set(week, proj.stats);
    weekOpponents.set(week, stats.opponents);
    weekTeams.set(week, stats.teams);

    for (const m of matchups) {
      const pp = m.players_points;
      if (!pp) continue;

      for (const [pid, sleeperPts] of Object.entries(pp)) {
        const line = stats.stats[pid];
        // Sleeper reports 0 for players with no stat line; nothing to compare.
        if (!line) {
          if (Math.abs(sleeperPts) > 0.01) {
            mismatches++;
            if (mismatchSamples.length < 10) {
              mismatchSamples.push(
                `wk${week} ${pid} (${playersById.get(pid)?.full_name ?? '?'}): sleeper=${sleeperPts} but no stat line`,
              );
            }
          }
          continue;
        }

        const ours = score(line);
        compared++;
        const delta = Math.abs(ours - sleeperPts);

        if (delta > 0.011) {
          mismatches++;
          if (delta > worstDelta) {
            worstDelta = delta;
            const p = playersById.get(pid);
            worstDetail = `wk${week} ${p?.full_name ?? pid} (${p?.position}) ours=${ours} sleeper=${sleeperPts}`;
          }
          if (mismatchSamples.length < 10) {
            const p = playersById.get(pid);
            mismatchSamples.push(
              `wk${week} ${p?.full_name ?? pid} (${p?.position}): ours=${ours} sleeper=${sleeperPts} Δ=${delta.toFixed(2)}`,
            );
          }
        }
      }
    }
  }

  console.log('\n');
  console.log('='.repeat(66));
  console.log('SCORING PARITY vs Sleeper players_points');
  console.log('='.repeat(66));
  console.log(`  compared      ${compared}`);
  console.log(`  mismatches    ${mismatches}`);
  console.log(`  match rate    ${(((compared - mismatches) / compared) * 100).toFixed(4)}%`);
  if (mismatches) {
    console.log(`  worst delta   ${worstDelta.toFixed(2)}  ${worstDetail}`);
    console.log('  samples:');
    for (const s of mismatchSamples) console.log(`    ${s}`);
  }

  // ---- Team totals ---------------------------------------------------------
  console.log('');
  console.log('='.repeat(66));
  console.log('TEAM STARTER TOTALS vs Sleeper matchup points (week 10)');
  console.log('='.repeat(66));

  const wk = 10;
  const m10 = await getMatchups(LEAGUE_ID, wk);
  const stats10 = weekStats.get(wk)!;
  for (const m of m10) {
    const ours = (m.starters ?? [])
      .filter((p) => p && p !== '0')
      .reduce((sum, pid) => sum + score(stats10[pid]), 0);
    const flag = Math.abs(ours - m.points) > 0.05 ? '  <-- MISMATCH' : '';
    console.log(
      `  roster ${String(m.roster_id).padStart(2)}  ours ${fmt(ours)}   sleeper ${fmt(m.points)}${flag}`,
    );
  }

  // ---- Derived models ------------------------------------------------------
  console.log('');
  console.log('='.repeat(66));
  console.log('VALUE INDEX');
  console.log('='.repeat(66));

  const valueIndex = buildValueIndex({
    scoringModel: model,
    playersById,
    weekStats,
    weekProjections: weekProj,
    weekOpponents,
    weekTeams,
    throughWeek: WEEKS,
  });
  const invalidValue = [...valueIndex.byPlayer.values()].find(
    (value) =>
      !Number.isFinite(value.score) ||
      !Number.isFinite(value.breakdown.scheduleAdjustedPpg) ||
      !Number.isFinite(value.breakdown.ewma),
  );
  if (invalidValue) throw new Error(`Invalid Value model output for ${invalidValue.pid}`);
  console.log(`  rated players ${valueIndex.byPlayer.size}`);

  const groups = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'] as const;
  for (const g of groups) {
    const top = [...valueIndex.byPlayer.values()]
      .filter((v) => v.group === g)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const names = top
      .map((v) => {
        const p = playersById.get(v.pid);
        return `${p?.full_name ?? v.pid} ${v.score}`;
      })
      .join('  |  ');
    console.log(`  ${g.padEnd(3)} ${names}`);
  }

  console.log('');
  console.log('='.repeat(66));
  console.log('MATCHUP INDEX (softest defences to face)');
  console.log('='.repeat(66));

  const matchupIndex = buildMatchupIndex({
    scoringModel: model,
    playersById,
    weekStats,
    weekOpponents,
    weekTeams,
    throughWeek: WEEKS,
  });
  const sourceTeams = new Set([...weekTeams.values()].flatMap((teams) => Object.values(teams)));
  const contextualExample = [...matchupIndex.byGroup.entries()]
    .flatMap(([group, entries]) =>
      [...entries.values()].flatMap((entry) =>
        [...sourceTeams].map((sourceTeam) => matchupIndex.get(group, entry.defense, sourceTeam)),
      ),
    )
    .find((entry) => entry?.unitStrengthScore !== null);
  if (
    !contextualExample ||
    !Number.isFinite(contextualExample.score) ||
    !Number.isFinite(contextualExample.opponentAdjustedPpg) ||
    !Number.isFinite(contextualExample.opportunitiesPerGame)
  ) {
    throw new Error('Contextual Matchup model did not produce a valid score');
  }

  for (const g of ['QB', 'RB', 'WR', 'TE', 'LB'] as const) {
    const entries = [...(matchupIndex.byGroup.get(g)?.values() ?? [])].sort(
      (a, b) => b.score - a.score,
    );
    const top = entries.slice(0, 3).map((e) => `${e.defense} ${e.score}`).join('  ');
    const bot = entries.slice(-3).map((e) => `${e.defense} ${e.score}`).join('  ');
    console.log(`  ${g.padEnd(3)} softest: ${top}   |   toughest: ${bot}`);
  }

  // ---- Optimal lineup ------------------------------------------------------
  console.log('');
  console.log('='.repeat(66));
  console.log('OPTIMAL LINEUP vs ACTUAL (week 10)');
  console.log('='.repeat(66));

  const slots = starterSlots(league.roster_positions);
  console.log(`  ${slots.length} starting slots: ${slots.join(' ')}`);

  for (const m of m10) {
    const roster = rosters.find((r) => r.roster_id === m.roster_id);
    const pool = (m.players ?? roster?.players ?? [])
      .filter((p) => p && p !== '0')
      .map((pid) => ({
        pid,
        group: groupForPlayer(playersById.get(pid)),
        points: score(stats10[pid]),
      }));

    const optimal = computeOptimalLineup(slots, pool);
    const actual = (m.starters ?? [])
      .filter((p) => p && p !== '0')
      .reduce((sum, pid) => sum + score(stats10[pid]), 0);

    const eff = optimal.total > 0 ? (actual / optimal.total) * 100 : 0;
    const bad = actual > optimal.total + 0.01 ? '  <-- IMPOSSIBLE' : '';
    console.log(
      `  roster ${String(m.roster_id).padStart(2)}  actual ${fmt(actual)}  optimal ${fmt(optimal.total)}  efficiency ${eff.toFixed(1)}%${bad}`,
    );
  }

  // Sanity: how many players actually played each week?
  const played = [...weekStats.values()].reduce(
    (n, wkStats) => n + Object.values(wkStats).filter(hasPlayed).length,
    0,
  );
  console.log('');
  console.log(`  total player-weeks with participation: ${played}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
