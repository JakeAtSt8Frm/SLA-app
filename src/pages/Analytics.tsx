/**
 * Analytics — league-wide standings, power ranking, and matchup research.
 *
 * The defensive-generosity table is the part that has no equivalent in a
 * standard fantasy tool: with seven IDP starters, knowing which offences
 * concede tackles and sacks is worth as much as knowing which secondaries
 * concede receiving yards.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek } from '../data/selectors';
import { EmptyState, MatchupChip, StatTile, StatTileRow, fmt1, fmtPct } from '../components/primitives';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

export function AnalyticsPage() {
  const data = useLeagueData();
  const { setSelectedRosterId } = useLeague();
  const [muGroup, setMuGroup] = useState<PositionGroup>('WR');

  /** Season aggregates per team, computed from our own scoring rather than
   *  Sleeper's stored fpts, so everything on the page agrees. */
  const standings = useMemo(() => {
    return data.teams
      .map((team) => {
        let actual = 0;
        let optimal = 0;
        let weeksPlayed = 0;
        const weekly: number[] = [];

        for (let w = 1; w <= data.currentWeek; w++) {
          const rw = buildRosterWeek(data, team.rosterId, w);
          if (!rw || rw.starters.length === 0) continue;
          actual += rw.actualTotal;
          optimal += rw.optimalTotal;
          weekly.push(rw.actualTotal);
          weeksPlayed++;
        }

        const avg = weeksPlayed ? actual / weeksPlayed : 0;
        const sorted = [...weekly].sort((a, b) => a - b);
        const median = sorted.length
          ? sorted[Math.floor(sorted.length / 2)]
          : 0;

        return {
          ...team,
          actual: round2(actual),
          optimal: round2(optimal),
          avg: round2(avg),
          median: round2(median),
          best: weekly.length ? round2(Math.max(...weekly)) : 0,
          worst: weekly.length ? round2(Math.min(...weekly)) : 0,
          efficiency: optimal > 0 ? actual / optimal : 0,
          weeksPlayed,
        };
      })
      .sort((a, b) => b.wins - a.wins || b.actual - a.actual);
  }, [data]);

  /**
   * Power ranking blends record with scoring, because in a 6-team league
   * schedule luck dominates the standings — a team can be 4-9 and still be the
   * second-best scoring roster.
   */
  const power = useMemo(() => {
    const maxAvg = Math.max(...standings.map((t) => t.avg), 1);
    return [...standings]
      .map((t) => {
        const games = t.wins + t.losses + t.ties;
        const winPct = games ? (t.wins + t.ties * 0.5) / games : 0;
        const scorePct = t.avg / maxAvg;
        return { ...t, winPct, scorePct, power: scorePct * 0.65 + winPct * 0.35 };
      })
      .sort((a, b) => b.power - a.power);
  }, [standings]);

  const defenses = useMemo(() => {
    const entries = data.matchupIndex.byGroup.get(muGroup);
    return entries ? [...entries.values()].sort((a, b) => b.score - a.score) : [];
  }, [data, muGroup]);

  const activeGroups = useMemo(
    () => POSITION_GROUPS.filter((g) => (data.matchupIndex.byGroup.get(g)?.size ?? 0) > 0),
    [data],
  );

  if (!standings.length) return <EmptyState title="No data yet" />;

  const leagueAvg = standings.reduce((s, t) => s + t.avg, 0) / standings.length;
  const bestWeek = Math.max(...standings.map((t) => t.best));
  const totalLeft = standings.reduce((s, t) => s + (t.optimal - t.actual), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Analytics</h1>
          <div className="small muted">
            Season through week {data.currentWeek}, all values custom-scored.
          </div>
        </div>
      </div>

      <StatTileRow>
        <StatTile label="League avg / week" value={fmt1(leagueAvg)} />
        <StatTile label="Best single week" value={fmt1(bestWeek)} />
        <StatTile label="Points left on benches" value={fmt1(totalLeft)} sub="league-wide" />
        <StatTile label="Scoring keys in use" value={String(data.scoringModel.keys.length)} />
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="stack">
        {/* ---- Standings ---- */}
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Standings &amp; scoring</span>
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">W-L</th>
                  <th className="num">Total</th>
                  <th className="num">Avg</th>
                  <th className="num">Median</th>
                  <th className="num">Best</th>
                  <th className="num">Worst</th>
                  <th className="num">Optimal</th>
                  <th className="num">Eff.</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((t) => (
                  <tr key={t.rosterId}>
                    <td>
                      <button className="bold" onClick={() => setSelectedRosterId(t.rosterId)}>
                        {t.name}
                      </button>
                      <div className="tiny muted">{t.ownerName}</div>
                    </td>
                    <td className="num">
                      {t.wins}-{t.losses}
                      {t.ties ? `-${t.ties}` : ''}
                    </td>
                    <td className="num bold">{fmt1(t.actual)}</td>
                    <td className="num">{fmt1(t.avg)}</td>
                    <td className="num muted">{fmt1(t.median)}</td>
                    <td className="num muted">{fmt1(t.best)}</td>
                    <td className="num muted">{fmt1(t.worst)}</td>
                    <td className="num muted">{fmt1(t.optimal)}</td>
                    <td className="num">{fmtPct(t.efficiency, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---- Power ranking ---- */}
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Power ranking</span>
            <span className="tiny">65% scoring · 35% record</span>
          </div>
          <div className="card-pad stack" style={{ gap: 10 }}>
            {power.map((t, i) => (
              <div key={t.rosterId} className="row" style={{ gap: 10 }}>
                <span className="mono bold" style={{ minWidth: 22 }}>
                  {i + 1}
                </span>
                <span style={{ minWidth: 0, flex: '0 0 30%', fontWeight: 600 }}>
                  <button onClick={() => setSelectedRosterId(t.rosterId)}>{t.name}</button>
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 10,
                    borderRadius: 999,
                    background: 'var(--surface-sunken)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${t.power * 100}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </span>
                <span className="mono small muted" style={{ minWidth: 96, textAlign: 'right' }}>
                  {fmt1(t.avg)}/wk · {(t.winPct * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Defensive generosity ---- */}
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Matchup research — points allowed by defence</span>
          </div>

          <div className="card-pad" style={{ paddingBottom: 0 }}>
            <div className="segmented" role="group" aria-label="Position group">
              {activeGroups.map((g) => (
                <button key={g} aria-pressed={muGroup === g} onClick={() => setMuGroup(g)}>
                  {g}
                </button>
              ))}
            </div>
            <p className="tiny muted" style={{ margin: '8px 0' }}>
              Matchup score is a defence's rank-percentile on a composite of generosity,
              recent trend, ceiling and floor rates, consistency and how often it yields a
              weekly top-10 performance. 100 = softest in the league.
            </p>
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
                {defenses.map((d) => (
                  <tr key={d.defense}>
                    <td className="bold">{d.defense}</td>
                    <td className="num">
                      <MatchupChip score={d.score} />
                    </td>
                    <td className="num bold">{fmt1(d.pointsPerGame)}</td>
                    <td className="num">{fmt1(d.last4)}</td>
                    <td className="num muted">{fmtPct(d.ceilingRate)}</td>
                    <td className="num muted">{fmtPct(d.floorRate)}</td>
                    <td className="num muted">{fmtPct(d.top10Rate)}</td>
                    <td className="num muted">{d.games}</td>
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
