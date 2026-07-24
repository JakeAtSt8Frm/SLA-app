/**
 * History — season-long trends and any past week's detail.
 *
 * The season chart is the one place where "did I actually manage this team
 * well" is answerable: actual against optimal, week by week. A team can score
 * well and still be leaving 60 points a week on the bench.
 */

import { useMemo, useState } from 'react';
import { LazyWeeklyBarChart, LazyWeeklyScoreChart } from '../components/LazyChart';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildHeatmap, buildRosterWeek } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import { EmptyState, StatTile, StatTileRow, fmt1, fmtPct } from '../components/primitives';
import type { HeatmapMetric } from '../data/selectors';

export function HistoryPage() {
  const data = useLeagueData();
  const { selectedRosterId, setSelectedRosterId } = useLeague();
  const [historyWeek, setHistoryWeek] = useState(data.currentWeek);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [metric, setMetric] = useState<HeatmapMetric>('actual');

  const rosterId = selectedRosterId ?? data.teams[0]?.rosterId ?? null;

  /** Actual / projected / optimal for every week of the season. */
  const season = useMemo(() => {
    if (rosterId === null) return [];
    const rows = [];
    for (let w = 1; w <= data.currentWeek; w++) {
      const rw = buildRosterWeek(data, rosterId, w);
      if (!rw) continue;
      // A week with no lineup recorded would plot as a misleading zero.
      if (rw.starters.length === 0) continue;
      rows.push({
        week: `W${w}`,
        weekNum: w,
        actual: rw.actualTotal,
        projected: rw.projectedTotal,
        optimal: rw.optimalTotal,
        efficiency: rw.efficiency,
        left: Math.round((rw.optimalTotal - rw.actualTotal) * 100) / 100,
      });
    }
    return rows;
  }, [data, rosterId]);

  const totals = useMemo(() => {
    if (!season.length) return null;
    const actual = season.reduce((s, r) => s + r.actual, 0);
    const optimal = season.reduce((s, r) => s + r.optimal, 0);
    const projected = season.reduce((s, r) => s + r.projected, 0);
    return {
      actual,
      optimal,
      projected,
      left: optimal - actual,
      efficiency: optimal > 0 ? actual / optimal : 0,
      avg: actual / season.length,
      best: Math.max(...season.map((r) => r.actual)),
      worst: Math.min(...season.map((r) => r.actual)),
    };
  }, [season]);

  const weekDetail = useMemo(
    () => (rosterId === null ? null : buildRosterWeek(data, rosterId, historyWeek)),
    [data, rosterId, historyWeek],
  );

  const heatmapRows = useMemo(
    () => buildHeatmap(data, historyWeek, 'starters', metric),
    [data, historyWeek, metric],
  );

  if (rosterId === null || !totals) {
    return <EmptyState title="No history yet" hint="Play a week first." />;
  }

  const team = data.teamsById.get(rosterId)!;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">History</h1>
          <div className="small muted">
            {team.name} · {season.length} weeks · custom scoring throughout
          </div>
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Select team">
          {data.teams.map((t) => (
            <button
              key={t.rosterId}
              aria-pressed={t.rosterId === rosterId}
              onClick={() => setSelectedRosterId(t.rosterId)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <StatTileRow>
        <StatTile label="Season total" value={fmt1(totals.actual)} sub={`${fmt1(totals.avg)} / week`} />
        <StatTile label="Optimal total" value={fmt1(totals.optimal)} />
        <StatTile
          label="Left on bench"
          value={fmt1(totals.left)}
          sub="across the season"
          tone={totals.left > 200 ? 'var(--danger-text)' : undefined}
        />
        <StatTile
          label="Season efficiency"
          value={fmtPct(totals.efficiency, 1)}
          tone={totals.efficiency >= 0.9 ? 'var(--success-text)' : undefined}
        />
        <StatTile label="Best week" value={fmt1(totals.best)} />
        <StatTile label="Worst week" value={fmt1(totals.worst)} />
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="stack">
        {/* ---- Season trend ---- */}
        <section className="card card-pad">
          <div className="section-title">Weekly actual vs projected vs optimal</div>
          <LazyWeeklyScoreChart data={season} height={280} showOptimal />
        </section>

        {/* ---- Points left on the bench ---- */}
        <section className="card card-pad">
          <div className="section-title">Points left on the bench, by week</div>
          <LazyWeeklyBarChart data={season} dataKey="left" label="Left on bench" height={200} />
          <div className="tiny muted" style={{ marginTop: 6 }}>
            Difference between the optimal lineup and what was actually started.
          </div>
        </section>

        {/* ---- Week detail ---- */}
        <div className="filters" style={{ marginBottom: 0 }}>
          <label className="small bold" htmlFor="history-week">
            Week detail
          </label>
          <select
            id="history-week"
            className="select"
            value={historyWeek}
            onChange={(e) => setHistoryWeek(Number(e.target.value))}
          >
            {season.map((r) => (
              <option key={r.weekNum} value={r.weekNum}>
                Week {r.weekNum} — {fmt1(r.actual)} pts
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Heatmap metric">
            <button aria-pressed={metric === 'actual'} onClick={() => setMetric('actual')}>
              Actual
            </button>
            <button aria-pressed={metric === 'projected'} onClick={() => setMetric('projected')}>
              Projected
            </button>
          </div>
        </div>

        <div className="grid-2">
          {weekDetail && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head" style={{ position: 'static' }}>
                <span>Week {historyWeek} starters</span>
                <span className="mono">{fmt1(weekDetail.actualTotal)}</span>
              </div>
              {weekDetail.starters.map((p) => (
                <PlayerRow key={p.pid} player={p} onSelect={setOpenPid} />
              ))}
            </section>
          )}

          <Heatmap
            title={`${metric === 'actual' ? 'Actual' : 'Projected'} points by position — week ${historyWeek}`}
            subtitle="Starting lineups, custom scoring."
            rows={heatmapRows}
            selectedRosterId={rosterId}
            onSelectTeam={setSelectedRosterId}
          />
        </div>
      </div>

      <PlayerModal pid={openPid} week={historyWeek} onClose={() => setOpenPid(null)} />
    </>
  );
}
