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
import { buildHeatmap, buildRosterWeek, buildStarterStrength } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import { useTheme } from '../components/ThemeProvider';
import { rankFill } from '../lib/colors';
import {
  EmptyState,
  PlacementBadge,
  StatTile,
  StatTileRow,
  fmt1,
  fmtPct,
} from '../components/primitives';
import { POSITION_GROUPS } from '../lib/types';
import type { EnrichedPlayer, PositionGroup } from '../lib/types';
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
  const { mode } = useTheme();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [scope, setScope] = useState<HeatmapScope>('starters');
  const [metric, setMetric] = useState<HeatmapMetric>('actual');

  const rosterId = selectedRosterId ?? data.teams[0]?.rosterId ?? null;

  const rosterWeek = useMemo(
    () => (rosterId === null ? null : buildRosterWeek(data, rosterId, week)),
    [data, rosterId, week],
  );

  // Where this team's *starting lineup* ranks league-wide, overall and by
  // position — the starter-based counterpart to Analytics' whole-roster power.
  const starterStrength = useMemo(() => buildStarterStrength(data), [data]);
  const starterRank = useMemo(() => {
    if (rosterId === null) return null;
    const outOf = starterStrength.length;
    const rankBy = (pick: (t: (typeof starterStrength)[number]) => number) => {
      const sorted = [...starterStrength].sort((a, b) => pick(b) - pick(a));
      return sorted.findIndex((t) => t.rosterId === rosterId) + 1;
    };
    const byGroup = Object.fromEntries(
      POSITION_GROUPS.map((group) => [group, rankBy((t) => t.positionAverages[group])]),
    ) as Record<PositionGroup, number>;
    return { overall: rankBy((t) => t.avg), outOf, byGroup };
  }, [starterStrength, rosterId]);

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

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">
          {team.name} <PlacementBadge placement={team.placement} />
        </h1>
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
              {t.placement === 1 ? ' 🏆' : ''}
            </button>
          ))}
        </div>
      </div>

      <StatTileRow>
        <StatTile label="Actual Score" value={fmt1(actualTotal)} />
        <StatTile label="Projected Score" value={fmt1(projectedTotal)} />
        <StatTile label="Optimal" value={fmt1(optimalTotal)} />
        <StatTile
          label="Efficiency"
          value={fmtPct(efficiency, 1)}
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
        Roster and heatmap sit side by side on a wide screen so the heatmap is
        visible without scrolling; below 1080px they stack. The split is gated on
        page width because a player line needs ~560px for the name plus its Value
        and rank pills before the name starts truncating.
      */}
      <div className="split-roster">
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

          {/* ---- Injured reserve ---- */}
          {injured.length > 0 && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head group-head--primary">
                <span>IR ({injured.length})</span>
              </div>
              {injured.map((p) => (
                <PlayerRow key={p.pid} player={p} onSelect={setOpenPid} />
              ))}
            </section>
          )}
        </div>

        {/* ---- Heatmap + status ---- */}
        <div className="stack split-roster__aside">
          <div className="filters" style={{ marginBottom: 0 }}>
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

          <Heatmap
            title={`${metric === 'actual' ? 'Actual' : 'Projected'} points by position — week ${week}`}
            rows={heatmapRows}
            selectedRosterId={rosterId}
            onSelectTeam={setSelectedRosterId}
          />

          <div className="card card-pad">
            <div className="section-title">Status breakdown</div>
            <StatusSummary players={starters} />
          </div>

          {starterRank && (
            <div className="card card-pad">
              <div className="section-title">Starter power rank</div>
              <StarterPowerRank rank={starterRank} mode={mode} />
            </div>
          )}
        </div>
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return Math.round(items.reduce((s, i) => s + pick(i), 0) * 100) / 100;
}

/** 1 -> "1st", 2 -> "2nd", ... */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * League rank of a team's starting lineup — overall and by position — on the
 * app's red→yellow→green scale, where first is green and last is red. The
 * numeral inside each chip is the non-colour channel, so the ranking is legible
 * without relying on hue.
 */
function StarterPowerRank({
  rank,
  mode,
}: {
  rank: { overall: number; outOf: number; byGroup: Record<PositionGroup, number> };
  mode: 'light' | 'dark';
}) {
  const chipStyle = (r: number) => {
    const { background, ink } = rankFill(r, rank.outOf, mode);
    return { background, color: ink };
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <span className="small" style={{ flex: 1 }}>
          Overall
        </span>
        <span className="rank-chip mono bold" style={chipStyle(rank.overall)}>
          {ordinal(rank.overall)}
          <span className="rank-chip__of"> of {rank.outOf}</span>
        </span>
      </div>

      <div className="rank-grid">
        {POSITION_GROUPS.map((group) => (
          <div key={group} className="rank-grid__cell">
            <span className="small muted">{group}</span>
            <span className="rank-chip mono bold" style={chipStyle(rank.byGroup[group])}>
              {ordinal(rank.byGroup[group])}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
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
