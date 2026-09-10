import { useEffect, useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { availabilityFactors, rosterStatus } from '../lib/availability';
import { getInjuryHistory, type InjuryHistory } from '../lib/nflContext';
import { playerMetrics } from '../lib/playerMetrics';
import { AvailabilityBadge } from './AvailabilityBadge';
import type { Player } from '../lib/types';

export function PlayerContext({ player }: { player: Player }) {
  const data = useLeagueData();
  const [history, setHistory] = useState<InjuryHistory | null | undefined>();
  useEffect(() => {
    let cancelled = false;
    void getInjuryHistory().then((result) => { if (!cancelled) setHistory(result); });
    return () => { cancelled = true; };
  }, []);
  const profile = useMemo(() => playerMetrics(player.player_id, player, data.weeks, data.currentWeek), [player, data]);
  const factors = availabilityFactors(player);
  const returnEstimate = player.currentInjury;
  const ppg = data.dynastyIndex.byPlayer.get(player.player_id)?.breakdown.projectedPpg
    ?? data.valueIndex.byPlayer.get(player.player_id)?.breakdown.ppg ?? null;
  const reports = player.gsis_id ? history?.players[player.gsis_id] ?? [] : [];
  const reportGroups = new Map<string, { season: number; injury: string; weeks: Set<number>; out: Set<number> }>();
  for (const report of reports) {
    const key = `${report.season}:${report.injury}`;
    const group = reportGroups.get(key) ?? { season: report.season, injury: report.injury, weeks: new Set(), out: new Set() };
    group.weeks.add(report.week);
    if (report.status === 'Out') group.out.add(report.week);
    reportGroups.set(key, group);
  }
  return <>
    <section className="availability-panel">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <h3 className="section-title">NFL availability <span className="tiny muted">· current</span></h3>
        <AvailabilityBadge player={player} includeActive />
      </div>
      <dl className="context-grid">
        <div><dt>Current NFL team</dt><dd>{['free-agent', 'retired'].includes(rosterStatus(player)) ? 'None' : player.nflRoster?.team || player.team || 'Not reported'}</dd></div>
        <div><dt>Depth chart</dt><dd>{player.depth_chart_order ? `Order ${player.depth_chart_order}` : 'Not reported'}</dd></div>
        <div><dt>Injury</dt><dd>{player.injury_body_part || returnEstimate?.injury || 'Not reported'}</dd></div>
        <div><dt>Practice</dt><dd>{player.practice_participation || player.practice_description || 'Not reported'}</dd></div>
        <div><dt>Reported since</dt><dd>{player.injury_start_date || 'Not reported'}</dd></div>
        <div><dt>Estimated return · ESPN</dt><dd>{returnEstimate?.returnDate
          ? new Date(`${returnEstimate.returnDate}T12:00:00`).toLocaleDateString() : 'Not reported'}</dd></div>
      </dl>
      {player.injury_notes && <p className="small">{player.injury_notes}</p>}
      <p className="tiny muted">{player.nflRoster ? `nflverse roster · ${new Date(player.nflRoster.asOf).toLocaleDateString()}` : 'Sleeper roster · supplemental status not available for this player'}. Injury and practice fields: Sleeper. Active roster does not guarantee game-day activation.</p>
      {returnEstimate && <p className="tiny muted"><a href="https://www.espn.com/nfl/injuries" target="_blank" rel="noreferrer">ESPN injury report</a> · {returnEstimate.status} · report {new Date(returnEstimate.reportedAt).toLocaleDateString()} · snapshot {new Date(returnEstimate.asOf).toLocaleDateString()}. Return dates are estimates, not medical clearance.</p>}
      {returnEstimate?.gamesBeforeReturn != null && <div className="value-adjustment">
        <strong>{returnEstimate.gamesBeforeReturn} scheduled games before estimated return</strong>
        {ppg !== null && <span>≈{(ppg * returnEstimate.gamesBeforeReturn).toFixed(1)} fantasy points at the player’s baseline rate</span>}
        <p className="tiny muted">A scenario using the NFL schedule; bye weeks do not count. This assumes no production before the estimate and does not predict a snap limit or reduced performance after return.</p>
      </div>}
      {returnEstimate?.returnDate && returnEstimate.gamesBeforeReturn === null && <p className="tiny muted">This return date has passed or no remaining schedule is available. It is not used to estimate missed games.</p>}
      {(factors.season < 1 || factors.dynasty < 1) && <div className="value-adjustment">
        <strong>Availability adjustment</strong>
        <span>In-season ×{factors.season.toFixed(2)} · Dynasty ×{factors.dynasty.toFixed(2)}</span>
        <p className="tiny muted">Applied to the headline Value Score. These are model discounts, not play probabilities or recovery estimates. The score breakdowns below show the underlying values before this adjustment.</p>
      </div>}
      {!returnEstimate?.returnDate && <p className="tiny muted">No return estimate is supplied. Weeks missed cannot be inferred reliably from the designation alone.</p>}
    </section>

    <section>
      <h3 className="section-title">Opportunity & efficiency <span className="tiny muted">· {data.season}</span></h3>
      <div className="metric-grid">
        {profile.metrics.map((metric) => <div className="metric" key={metric.label} title={metric.detail}>
          <div className="tiny muted">{metric.label}</div>
          <div className="mono bold">{metric.value === null ? '—' : `${metric.value.toFixed(metric.label === 'WOPR' ? 2 : 1)}${metric.unit === 'percent' ? '%' : ''}`}</div>
        </div>)}
      </div>
      <p className="tiny muted">{profile.games} games with participation. — means the required stat or denominator is unavailable. Routes, YPRR, xFP, EPA and tracking-based metrics need an additional data source.</p>
    </section>

    <details className="context-details">
      <summary>Injury-report history <span className="tiny muted">2023–2024 coverage</span></summary>
      <p className="tiny muted">Historical NFL injury reports via nflverse. The public feed ends in 2024; 2025–2026 history is unavailable. Reported weeks are not separate injuries or confirmed games missed.</p>
      {history === undefined ? <p className="small muted">Loading report history…</p>
        : history === null ? <p className="small muted">Injury history could not be loaded.</p>
          : !reports.length ? <p className="small muted">No matched reports in the covered seasons. This does not establish a clean injury history.</p>
            : <div className="table-scroll"><table className="context-table">
              <thead><tr><th>Season</th><th>Reported injury</th><th>Report weeks</th><th>Out reports</th></tr></thead>
              <tbody>{[...reportGroups.entries()].sort(([, a], [, b]) => b.season - a.season || b.weeks.size - a.weeks.size).map(([key, report]) =>
                <tr key={key}><td>{report.season}</td><td>{report.injury}</td><td>{report.weeks.size}</td><td>{report.out.size}</td></tr>)}</tbody>
            </table></div>}
    </details>
  </>;
}
