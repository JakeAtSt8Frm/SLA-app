import { useEffect, useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { availabilityFactors, rosterStatus } from '../lib/availability';
import { getInjuryHistory, type InjuryHistory } from '../lib/nflContext';
import { playerMetrics } from '../lib/playerMetrics';
import { AvailabilityBadge } from './AvailabilityBadge';
import type { Player } from '../lib/types';

/**
 * Season production rates. Split from the availability panel so the player
 * sheet can place this with the other season sections and keep today's NFL
 * status at the very bottom.
 */
export function PlayerOpportunity({ player }: { player: Player }) {
  const data = useLeagueData();
  const profile = useMemo(() => playerMetrics(player.player_id, player, data.weeks, data.currentWeek), [player, data]);

  return (
    <section>
      <h3 className="section-title">Opportunity &amp; efficiency <span className="tiny muted">· {data.season}</span></h3>
      <div className="metric-grid">
        {profile.metrics.map((metric) => <div className="metric" key={metric.label} title={metric.detail}>
          <div className="tiny muted">{metric.label}</div>
          <div className="mono bold">{metric.value === null ? '—' : `${metric.value.toFixed(metric.label === 'WOPR' ? 2 : 1)}${metric.unit === 'percent' ? '%' : ''}`}</div>
        </div>)}
      </div>
      <p className="tiny muted">{profile.games} games with participation.</p>
    </section>
  );
}

/** Today's NFL status, its effect on Value, and the injury-report history. */
export function PlayerAvailability({ player }: { player: Player }) {
  const data = useLeagueData();
  const [history, setHistory] = useState<InjuryHistory | null | undefined>();
  useEffect(() => {
    let cancelled = false;
    void getInjuryHistory().then((result) => { if (!cancelled) setHistory(result); });
    return () => { cancelled = true; };
  }, []);
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
      {/* Provenance only — which source and how old, so a stale field is visible. */}
      <p className="tiny muted">{player.nflRoster ? `nflverse roster · ${new Date(player.nflRoster.asOf).toLocaleDateString()}` : 'Sleeper roster · supplemental status unavailable'} · injury and practice: Sleeper.</p>
      {returnEstimate && <p className="tiny muted"><a href="https://www.espn.com/nfl/injuries" target="_blank" rel="noreferrer">ESPN injury report</a> · {returnEstimate.status} · report {new Date(returnEstimate.reportedAt).toLocaleDateString()} · snapshot {new Date(returnEstimate.asOf).toLocaleDateString()}.</p>}
      {returnEstimate?.gamesBeforeReturn != null && <div className="value-adjustment">
        <strong>{returnEstimate.gamesBeforeReturn} scheduled games before estimated return</strong>
        {ppg !== null && <span>≈{(ppg * returnEstimate.gamesBeforeReturn).toFixed(1)} fantasy points at the player’s baseline rate</span>}
      </div>}
      {(factors.season < 1 || factors.dynasty < 1) && <div className="value-adjustment">
        <strong>Availability adjustment</strong>
        <span>In-season ×{factors.season.toFixed(2)} · Dynasty ×{factors.dynasty.toFixed(2)}</span>
      </div>}
    </section>

    <details className="context-details">
      <summary>Injury-report history <span className="tiny muted">2023–2024 coverage</span></summary>
      {history === undefined ? <p className="small muted">Loading report history…</p>
        : history === null ? <p className="small muted">Injury history could not be loaded.</p>
          : !reports.length ? <p className="small muted">No matched reports in the covered seasons.</p>
            : <div className="table-scroll"><table className="context-table">
              <thead><tr><th>Season</th><th>Reported injury</th><th>Report weeks</th><th>Out reports</th></tr></thead>
              <tbody>{[...reportGroups.entries()].sort(([, a], [, b]) => b.season - a.season || b.weeks.size - a.weeks.size).map(([key, report]) =>
                <tr key={key}><td>{report.season}</td><td>{report.injury}</td><td>{report.weeks.size}</td><td>{report.out.size}</td></tr>)}</tbody>
            </table></div>}
    </details>
  </>;
}
