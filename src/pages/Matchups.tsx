/**
 * Matchups — head-to-head for the selected week.
 *
 * Each pairing shows both lineups side by side with a running custom-scored
 * total, so a game in progress reads at a glance.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek, type RosterWeek } from '../data/selectors';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState, fmt1, fmtPct, StatusBadge } from '../components/primitives';

interface Pairing {
  matchupId: number;
  a: RosterWeek;
  b: RosterWeek | null;
}

export function MatchupsPage() {
  const data = useLeagueData();
  const { week } = useLeague();
  const [openPid, setOpenPid] = useState<string | null>(null);

  const pairings = useMemo<Pairing[]>(() => {
    const weekData = data.weeks.get(week);
    if (!weekData) return [];

    const byMatchup = new Map<number, number[]>();
    for (const m of weekData.matchups) {
      if (m.matchup_id === null || m.matchup_id === undefined) continue;
      const list = byMatchup.get(m.matchup_id);
      if (list) list.push(m.roster_id);
      else byMatchup.set(m.matchup_id, [m.roster_id]);
    }

    return [...byMatchup.entries()]
      .map(([matchupId, rosterIds]) => {
        const a = buildRosterWeek(data, rosterIds[0], week);
        const b = rosterIds[1] !== undefined ? buildRosterWeek(data, rosterIds[1], week) : null;
        return a ? { matchupId, a, b } : null;
      })
      .filter((x): x is Pairing => x !== null)
      .sort((x, y) => x.matchupId - y.matchupId);
  }, [data, week]);

  if (!pairings.length) {
    return (
      <EmptyState
        title={`No matchups for week ${week}`}
        hint="Pick a different week from the selector above."
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Week {week} matchups</h1>
          <div className="small muted">All totals use this league's custom scoring.</div>
        </div>
      </div>

      <div className="stack">
        {pairings.map(({ matchupId, a, b }) => (
          <MatchupCard key={matchupId} a={a} b={b} onSelect={setOpenPid} />
        ))}
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function MatchupCard({
  a,
  b,
  onSelect,
}: {
  a: RosterWeek;
  b: RosterWeek | null;
  onSelect: (pid: string) => void;
}) {
  if (!b) {
    return (
      <section className="card card-pad">
        <div className="row-between">
          <span className="bold">{a.team.name}</span>
          <span className="mono bold">{fmt1(a.actualTotal)}</span>
        </div>
        <div className="tiny muted">Bye week — no opponent.</div>
      </section>
    );
  }

  const aWinning = a.actualTotal >= b.actualTotal;
  const margin = Math.abs(a.actualTotal - b.actualTotal);

  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <header
        className="row-between"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}
      >
        <TeamHeader team={a} leading={aWinning} align="left" />
        <div style={{ textAlign: 'center', flexShrink: 0, padding: '0 10px' }}>
          <div className="tiny muted">margin</div>
          <div className="mono bold">{fmt1(margin)}</div>
        </div>
        <TeamHeader team={b} leading={!aWinning} align="right" />
      </header>

      <div className="matchup-body">
        <LineupColumn roster={a} onSelect={onSelect} align="left" />
        <LineupColumn roster={b} onSelect={onSelect} align="right" />
      </div>

      <style>{`
        .matchup-body {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1px;
          background: var(--grid);
        }
        .matchup-col { background: var(--surface); padding: 4px 0; }
        .matchup-row {
          display: flex; align-items: center; gap: 8px;
          width: 100%; padding: 5px 12px; font-size: 13px;
        }
        .matchup-row:hover { background: var(--surface-sunken); }
        .matchup-row.is-right { flex-direction: row-reverse; text-align: right; }
        .matchup-row__name {
          flex: 1; min-width: 0; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
        }
      `}</style>
    </section>
  );
}

function TeamHeader({
  team,
  leading,
  align,
}: {
  team: RosterWeek;
  leading: boolean;
  align: 'left' | 'right';
}) {
  return (
    <div style={{ minWidth: 0, flex: 1, textAlign: align }}>
      <div className="bold" style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {team.team.name}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 24,
          fontWeight: 800,
          color: leading ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}
      >
        {fmt1(team.actualTotal)}
      </div>
      <div className="tiny muted">
        proj {fmt1(team.projectedTotal)} · eff {fmtPct(team.efficiency, 0)}
      </div>
    </div>
  );
}

function LineupColumn({
  roster,
  onSelect,
  align,
}: {
  roster: RosterWeek;
  onSelect: (pid: string) => void;
  align: 'left' | 'right';
}) {
  return (
    <div className="matchup-col">
      {roster.starters.map((p) => (
        <button
          key={p.pid}
          className={`matchup-row${align === 'right' ? ' is-right' : ''}`}
          onClick={() => onSelect(p.pid)}
        >
          <span className="chip chip-outline tiny" style={{ minWidth: 30, justifyContent: 'center' }}>
            {p.slot.replace(/_FLEX/, 'F').replace(/SUPER_/, 'S')}
          </span>
          <span className="matchup-row__name">{p.name}</span>
          <StatusBadge status={p.status} compact />
          <span className="mono bold" style={{ minWidth: 42, textAlign: 'right' }}>
            {p.hasPlayed ? fmt1(p.act) : fmt1(p.proj)}
          </span>
        </button>
      ))}
    </div>
  );
}
