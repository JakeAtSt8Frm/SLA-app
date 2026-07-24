/**
 * Teams — the roster view.
 *
 * Starters are grouped by slot type rather than listed in raw roster order,
 * because with 21 starting slots (four LB, three DL, three DB) a flat list is
 * unreadable. Each group shows its own projected/actual subtotal so positional
 * strengths and holes are visible without leaving the page.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildHeatmap, buildRosterWeek } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import { EmptyState, StatTile, StatTileRow, fmt1, fmtPct } from '../components/primitives';
import type { EnrichedPlayer } from '../lib/types';
import type { HeatmapMetric, HeatmapScope } from '../data/selectors';

/** Display order and labels for starter slot groups. */
const SLOT_GROUPS: Array<{ key: string; label: string; slots: string[] }> = [
  { key: 'QB', label: 'Quarterback', slots: ['QB'] },
  { key: 'RB', label: 'Running Backs', slots: ['RB'] },
  { key: 'WR', label: 'Wide Receivers', slots: ['WR'] },
  { key: 'TE', label: 'Tight End', slots: ['TE'] },
  {
    key: 'FLEX',
    label: 'Flex',
    slots: ['SUPER_FLEX', 'OP', 'FLEX', 'WRRB_FLEX', 'RBWR_FLEX', 'REC_FLEX', 'WRTE_FLEX', 'RBWRTE'],
  },
  { key: 'K', label: 'Kicker', slots: ['K'] },
  { key: 'DL', label: 'Defensive Line', slots: ['DL'] },
  { key: 'LB', label: 'Linebackers', slots: ['LB'] },
  { key: 'DB', label: 'Defensive Backs', slots: ['DB'] },
  { key: 'IDP', label: 'IDP Flex', slots: ['IDP_FLEX', 'DP'] },
];

export function TeamsPage() {
  const data = useLeagueData();
  const { week, selectedRosterId, setSelectedRosterId } = useLeague();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [scope, setScope] = useState<HeatmapScope>('starters');
  const [metric, setMetric] = useState<HeatmapMetric>('actual');

  const rosterId = selectedRosterId ?? data.teams[0]?.rosterId ?? null;

  const rosterWeek = useMemo(
    () => (rosterId === null ? null : buildRosterWeek(data, rosterId, week)),
    [data, rosterId, week],
  );

  const heatmapRows = useMemo(
    () => buildHeatmap(data, week, scope, metric),
    [data, week, scope, metric],
  );

  const grouped = useMemo(() => {
    if (!rosterWeek) return [];
    return SLOT_GROUPS.map((group) => {
      const players = rosterWeek.starters.filter((p) =>
        group.slots.includes(p.slot.toUpperCase()),
      );
      return { ...group, players };
    }).filter((g) => g.players.length > 0);
  }, [rosterWeek]);

  if (!rosterWeek) {
    return <EmptyState title="No team selected" />;
  }

  const { team, starters, bench, injured, projectedTotal, actualTotal, optimalTotal, efficiency } =
    rosterWeek;

  const pointsLeftOnBench = Math.max(0, optimalTotal - actualTotal);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{team.name}</h1>
          <div className="small muted">
            {team.ownerName} · {team.wins}-{team.losses}
            {team.ties ? `-${team.ties}` : ''} · Week {week}
          </div>
        </div>
      </div>

      {/* Team switcher */}
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
        <StatTile label="Actual Score" value={fmt1(actualTotal)} sub="starters" />
        <StatTile label="Projected Score" value={fmt1(projectedTotal)} sub="starters" />
        <StatTile
          label="Optimal"
          value={fmt1(optimalTotal)}
          sub="best possible lineup"
        />
        <StatTile
          label="Efficiency"
          value={fmtPct(efficiency, 1)}
          sub={
            pointsLeftOnBench > 0.05
              ? `${fmt1(pointsLeftOnBench)} left on bench`
              : 'perfect lineup'
          }
          tone={
            efficiency >= 0.95
              ? 'var(--success-text)'
              : efficiency < 0.8
                ? 'var(--danger-text)'
                : undefined
          }
        />
      </StatTileRow>

      <div style={{ height: 16 }} />

      {/*
        The roster runs full width rather than sharing the row with the heatmap.
        A player line carries the name plus Value and both rank pills, which
        needs about 500px before the name starts truncating — in a half-width
        column it was collapsing to nothing.
      */}
      <div className="stack">
        <div className="stack">
          {/* ---- Starters, grouped by slot ---- */}
          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>Starters ({starters.length})</span>
              <span className="mono">
                {fmt1(projectedTotal)} proj · {fmt1(actualTotal)} act
              </span>
            </div>

            {grouped.map((group) => (
              <div key={group.key}>
                <div className="group-head">
                  <span>{group.label}</span>
                  <span className="mono">{fmt1(sum(group.players, (p) => p.act))}</span>
                </div>
                {group.players.map((p) => (
                  <PlayerRow key={p.pid} player={p} onSelect={setOpenPid} />
                ))}
              </div>
            ))}
          </section>

          {/* ---- Bench ---- */}
          {bench.length > 0 && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head group-head--primary">
                <span>Bench ({bench.length})</span>
                <span className="mono">{fmt1(sum(bench, (p) => p.act))}</span>
              </div>
              {bench.map((p) => (
                <PlayerRow key={p.pid} player={p} onSelect={setOpenPid} />
              ))}
            </section>
          )}

          {/* ---- IR / out ---- */}
          {injured.length > 0 && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head group-head--primary">
                <span>Injured / Out ({injured.length})</span>
              </div>
              {injured.map((p) => (
                <PlayerRow key={p.pid} player={p} onSelect={setOpenPid} />
              ))}
            </section>
          )}
        </div>

        {/* ---- Heatmap + status, below the roster ---- */}
        <div className="filters" style={{ marginTop: 6, marginBottom: 0 }}>
          <div className="segmented" role="group" aria-label="Heatmap scope">
            <button aria-pressed={scope === 'starters'} onClick={() => setScope('starters')}>
              Starters
            </button>
            <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              Full roster
            </button>
          </div>
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
          <Heatmap
            title={`${metric === 'actual' ? 'Actual' : 'Projected'} points by position — week ${week}`}
            subtitle={`${scope === 'starters' ? 'Starting lineups' : 'Full rosters'}. Grouped by a player's real position, not the slot they filled, so an LB started at DL counts under LB. Colour compares teams within each column.`}
            rows={heatmapRows}
            selectedRosterId={rosterId}
            onSelectTeam={setSelectedRosterId}
          />

          <div className="card card-pad">
            <div className="section-title">Status breakdown</div>
            <StatusSummary players={starters} />
          </div>
        </div>
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return Math.round(items.reduce((s, i) => s + pick(i), 0) * 100) / 100;
}

/** Counts of each boom/bust classification across a lineup. */
function StatusSummary({ players }: { players: EnrichedPlayer[] }) {
  const counts = new Map<string, number>();
  for (const p of players) {
    counts.set(p.status.label, (counts.get(p.status.label) ?? 0) + 1);
  }

  const order = ['Major Boom', 'Boom', 'In Range', 'Bust', 'Major Bust', 'Not Played'];
  const rows = order.filter((label) => counts.has(label));

  if (!rows.length) return <div className="small muted">No results yet this week.</div>;

  const total = players.length;

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((label) => {
        const n = counts.get(label)!;
        return (
          <div key={label} className="row" style={{ gap: 8 }}>
            <span className="small" style={{ minWidth: 92 }}>
              {label}
            </span>
            <span
              style={{
                flex: 1,
                height: 8,
                borderRadius: 999,
                background: 'var(--surface-sunken)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${(n / total) * 100}%`,
                  background: 'var(--accent)',
                }}
              />
            </span>
            <span className="mono small" style={{ minWidth: 20, textAlign: 'right' }}>
              {n}
            </span>
          </div>
        );
      })}
    </div>
  );
}
