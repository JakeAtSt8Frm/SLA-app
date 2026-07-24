/**
 * Analytics — league-wide standings, schedule-independent team strength and
 * matchup research, all computed with this league's custom scoring.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek } from '../data/selectors';
import {
  EmptyState,
  MatchupChip,
  PlacementBadge,
  StatTile,
  StatTileRow,
  fmt1,
  fmtPct,
  fmtSigned,
} from '../components/primitives';
import { useTheme } from '../components/ThemeProvider';
import { teamColor } from '../lib/colors';
import { mean, percentileRanks, quantile, round, stdev } from '../lib/stats';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

interface AllPlayRecord {
  wins: number;
  losses: number;
  ties: number;
}

export function AnalyticsPage() {
  const data = useLeagueData();
  const { setSelectedRosterId } = useLeague();
  const { mode } = useTheme();
  const [muGroup, setMuGroup] = useState<PositionGroup>('WR');

  /**
   * Build every team-week once. buildRosterWeek is memoized, so this also warms
   * the selector cache for Teams, Optimal and History.
   */
  const standings = useMemo(() => {
    const base = data.teams.map((team) => {
      const weekly = [];

      for (let week = 1; week <= data.currentWeek; week++) {
        const rosterWeek = buildRosterWeek(data, team.rosterId, week);
        if (!rosterWeek || rosterWeek.starters.length === 0) continue;
        weekly.push({
          week,
          actual: rosterWeek.actualTotal,
          optimal: rosterWeek.optimalTotal,
        });
      }

      const scores = weekly.map((row) => row.actual);
      const actual = scores.reduce((sum, score) => sum + score, 0);
      const optimal = weekly.reduce((sum, row) => sum + row.optimal, 0);
      const recentScores = scores.slice(-4);

      return {
        ...team,
        weekly,
        actual: round(actual),
        optimal: round(optimal),
        avg: round(mean(scores)),
        recentAvg: round(mean(recentScores)),
        median: round(quantile(scores, 0.5)),
        best: scores.length ? round(Math.max(...scores)) : 0,
        volatility: round(stdev(scores)),
        efficiency: optimal > 0 ? actual / optimal : 0,
      };
    });

    // All-play asks how each team would fare against every other team each
    // regular-season week, removing the noise of the actual head-to-head draw.
    const allPlay = new Map<number, AllPlayRecord>(
      base.map((team) => [team.rosterId, { wins: 0, losses: 0, ties: 0 }]),
    );
    const regularSeasonWeeks = Math.max(
      0,
      ...base.map((team) => team.wins + team.losses + team.ties),
    );

    for (let week = 1; week <= Math.min(regularSeasonWeeks, data.currentWeek); week++) {
      const weekScores = base
        .map((team) => ({
          rosterId: team.rosterId,
          score: team.weekly.find((row) => row.week === week)?.actual,
        }))
        .filter((row): row is { rosterId: number; score: number } => row.score !== undefined);

      for (let i = 0; i < weekScores.length; i++) {
        for (let j = i + 1; j < weekScores.length; j++) {
          const a = weekScores[i];
          const b = weekScores[j];
          const aRecord = allPlay.get(a.rosterId)!;
          const bRecord = allPlay.get(b.rosterId)!;

          if (a.score === b.score) {
            aRecord.ties++;
            bRecord.ties++;
          } else if (a.score > b.score) {
            aRecord.wins++;
            bRecord.losses++;
          } else {
            bRecord.wins++;
            aRecord.losses++;
          }
        }
      }
    }

    return base
      .map((team) => {
        const record = allPlay.get(team.rosterId)!;
        const comparisons = record.wins + record.losses + record.ties;
        const allPlayPct = comparisons
          ? (record.wins + record.ties * 0.5) / comparisons
          : 0;
        const games = team.wins + team.losses + team.ties;
        const expectedWins = allPlayPct * games;
        const actualWins = team.wins + team.ties * 0.5;

        return {
          ...team,
          winPct: games ? actualWins / games : 0,
          allPlay: record,
          allPlayPct,
          expectedWins,
          scheduleLuck: actualWins - expectedWins,
        };
      })
      .sort((a, b) => b.wins - a.wins || b.actual - a.actual);
  }, [data]);

  /**
   * Power is schedule-independent and deliberately transparent:
   * 45% season scoring, 25% last-four form, 20% all-play and 10% management.
   */
  const power = useMemo(() => {
    const rank = (pick: (team: (typeof standings)[number]) => number) =>
      percentileRanks(
        standings.map((team) => ({ id: String(team.rosterId), value: pick(team) })),
      );

    const scoring = rank((team) => team.avg);
    const form = rank((team) => team.recentAvg);
    const management = rank((team) => team.efficiency);

    return standings
      .map((team) => {
        const id = String(team.rosterId);
        const powerIndex =
          ((scoring.get(id) ?? 0) * 0.45 +
            (form.get(id) ?? 0) * 0.25 +
            team.allPlayPct * 0.2 +
            (management.get(id) ?? 0) * 0.1) *
          100;
        return { ...team, powerIndex: round(powerIndex, 1) };
      })
      .sort((a, b) => b.powerIndex - a.powerIndex);
  }, [standings]);

  const defenses = useMemo(() => {
    const entries = data.matchupIndex.byGroup.get(muGroup);
    return entries ? [...entries.values()].sort((a, b) => b.score - a.score) : [];
  }, [data, muGroup]);

  const activeGroups = useMemo(
    () => POSITION_GROUPS.filter((group) => (data.matchupIndex.byGroup.get(group)?.size ?? 0) > 0),
    [data],
  );

  if (!standings.length) return <EmptyState title="No data yet" />;

  const leagueAvg = mean(standings.map((team) => team.avg));
  const totalLeft = standings.reduce((sum, team) => sum + (team.optimal - team.actual), 0);
  const bestWeekTeam = standings.reduce((best, team) => (team.best > best.best ? team : best));
  const efficientTeam = standings.reduce((best, team) =>
    team.efficiency > best.efficiency ? team : best,
  );
  const unluckiestTeam = standings.reduce((lowest, team) =>
    team.scheduleLuck < lowest.scheduleLuck ? team : lowest,
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Analytics</h1>
      </div>

      <StatTileRow>
        <StatTile label="League avg / week" value={fmt1(leagueAvg)} />
        <StatTile label={`Best week · ${bestWeekTeam.name}`} value={fmt1(bestWeekTeam.best)} />
        <StatTile
          label={`Top efficiency · ${efficientTeam.name}`}
          value={fmtPct(efficientTeam.efficiency, 1)}
        />
        <StatTile
          label={`Unluckiest · ${unluckiestTeam.name}`}
          value={`${fmtSigned(unluckiestTeam.scheduleLuck)} W`}
        />
        <StatTile label="Points left on benches" value={fmt1(totalLeft)} />
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="stack">
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Standings &amp; team metrics</span>
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">W-L</th>
                  <th className="num">Total</th>
                  <th className="num">Avg</th>
                  <th className="num">Last 4</th>
                  <th className="num">Median</th>
                  <th className="num">High</th>
                  <th className="num" title="Weekly scoring standard deviation; lower is steadier">
                    Vol.
                  </th>
                  <th className="num" title="Record against every other team each regular-season week">
                    All-play
                  </th>
                  <th className="num" title="Actual wins minus wins expected from all-play performance">
                    Luck
                  </th>
                  <th className="num">Eff.</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((team) => {
                  const color = teamColor(team.rosterId, mode);
                  return (
                    <tr key={team.rosterId}>
                      <td>
                        <button
                          className="team-name"
                          style={{ color }}
                          onClick={() => setSelectedRosterId(team.rosterId)}
                        >
                          <span
                            className="team-name__dot"
                            style={{ background: color }}
                            aria-hidden="true"
                          />
                          {team.name} <PlacementBadge placement={team.placement} />
                        </button>
                      </td>
                      <td className="num">
                        {team.wins}-{team.losses}
                        {team.ties ? `-${team.ties}` : ''}
                      </td>
                      <td className="num bold">{fmt1(team.actual)}</td>
                      <td className="num">{fmt1(team.avg)}</td>
                      <td className="num">{fmt1(team.recentAvg)}</td>
                      <td className="num muted">{fmt1(team.median)}</td>
                      <td className="num muted">{fmt1(team.best)}</td>
                      <td className="num muted">{fmt1(team.volatility)}</td>
                      <td className="num">
                        {team.allPlay.wins}-{team.allPlay.losses}
                        {team.allPlay.ties ? `-${team.allPlay.ties}` : ''}
                      </td>
                      <td
                        className="num bold"
                        style={{
                          color:
                            team.scheduleLuck > 0.05
                              ? 'var(--success-text)'
                              : team.scheduleLuck < -0.05
                                ? 'var(--danger-text)'
                                : undefined,
                        }}
                      >
                        {fmtSigned(team.scheduleLuck)}
                      </td>
                      <td className="num">{fmtPct(team.efficiency, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="card"
          style={{ overflow: 'hidden' }}
          aria-describedby="power-formula"
        >
          <div className="group-head group-head--primary">
            <span>Power index</span>
          </div>
          <p id="power-formula" className="sr-only">
            Power index weights season scoring 45 percent, last-four form 25 percent,
            all-play performance 20 percent and lineup efficiency 10 percent.
          </p>
          <div className="card-pad power-list">
            {power.map((team, index) => {
              const color = teamColor(team.rosterId, mode);
              return (
                <div key={team.rosterId} className="power-row">
                  <span className="power-rank mono bold">{index + 1}</span>
                  <button
                    className="team-name power-team"
                    style={{ color }}
                    onClick={() => setSelectedRosterId(team.rosterId)}
                  >
                    <span
                      className="team-name__dot"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    {team.name}
                  </button>
                  <span
                    className="power-track"
                    role="meter"
                    aria-label={`${team.name} power index`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={team.powerIndex}
                  >
                    <span
                      className="power-fill"
                      style={{ width: `${team.powerIndex}%`, background: color }}
                    />
                  </span>
                  <span className="power-value mono bold">{team.powerIndex.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Matchup research — points allowed by defence</span>
          </div>

          <div className="card-pad" style={{ paddingBottom: 10 }}>
            <div className="segmented" role="group" aria-label="Position group">
              {activeGroups.map((group) => (
                <button
                  key={group}
                  aria-pressed={muGroup === group}
                  onClick={() => setMuGroup(group)}
                >
                  {group}
                </button>
              ))}
            </div>
          </div>

          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Defence</th>
                  <th className="num">Matchup</th>
                  <th className="num">Allowed/gm</th>
                  <th className="num">Last 4</th>
                  <th className="num">Ceiling%</th>
                  <th className="num">Floor%</th>
                  <th className="num">Top-10%</th>
                  <th className="num">Games</th>
                </tr>
              </thead>
              <tbody>
                {defenses.map((defense) => (
                  <tr key={defense.defense}>
                    <td className="bold">{defense.defense}</td>
                    <td className="num">
                      <MatchupChip score={defense.score} />
                    </td>
                    <td className="num bold">{fmt1(defense.pointsPerGame)}</td>
                    <td className="num">{fmt1(defense.last4)}</td>
                    <td className="num muted">{fmtPct(defense.ceilingRate)}</td>
                    <td className="num muted">{fmtPct(defense.floorRate)}</td>
                    <td className="num muted">{fmtPct(defense.top10Rate)}</td>
                    <td className="num muted">{defense.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
