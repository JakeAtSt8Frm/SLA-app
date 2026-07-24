/**
 * Trade analyser.
 *
 * Compares two sides on Value Score, but the number that actually decides a
 * trade is the **starting-lineup impact**: what each roster's optimal lineup is
 * worth before and after. A team stacked at linebacker can trade its LB4 for a
 * WR2 and gain, even though raw Value goes down — and in a league with four
 * starting LB slots and a superflex, that positional context is everything.
 */

import { useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek } from '../data/selectors';
import { computeOptimalLineup } from '../lib/optimal';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState, StatTile, StatTileRow, ValueChip, fmt1 } from '../components/primitives';
import { groupForPlayer } from '../lib/scoring';
import { playerName } from '../data/league';
import type { EnrichedPlayer } from '../lib/types';

export function TradePage() {
  const data = useLeagueData();
  const [teamA, setTeamA] = useState(data.teams[0]?.rosterId ?? 0);
  const [teamB, setTeamB] = useState(data.teams[1]?.rosterId ?? 0);
  const [sendA, setSendA] = useState<Set<string>>(new Set());
  const [sendB, setSendB] = useState<Set<string>>(new Set());
  const [openPid, setOpenPid] = useState<string | null>(null);

  const week = data.currentWeek;

  const rosterA = useMemo(() => buildRosterWeek(data, teamA, week), [data, teamA, week]);
  const rosterB = useMemo(() => buildRosterWeek(data, teamB, week), [data, teamB, week]);

  /**
   * Evaluates both rosters before and after the swap.
   *
   * Lineup strength is measured on season PPG rather than a single week's
   * result, because one week is far too noisy to judge a trade on.
   */
  const analysis = useMemo(() => {
    if (!rosterA || !rosterB) return null;

    const ppg = (pid: string): number => {
      const v = data.valueIndex.byPlayer.get(pid);
      return v ? v.breakdown.ppg : 0;
    };

    const strength = (pids: string[]): number => {
      const pool = pids.map((pid) => ({
        pid,
        group: groupForPlayer(data.playersById.get(pid)),
        points: ppg(pid),
      }));
      return computeOptimalLineup(data.starterSlots, pool).total;
    };

    const idsA = rosterA.all.map((p) => p.pid);
    const idsB = rosterB.all.map((p) => p.pid);

    const outA = [...sendA];
    const outB = [...sendB];

    const afterA = [...idsA.filter((id) => !sendA.has(id)), ...outB];
    const afterB = [...idsB.filter((id) => !sendB.has(id)), ...outA];

    const valueOf = (pids: string[]) =>
      pids.reduce((s, pid) => s + (data.valueIndex.byPlayer.get(pid)?.score ?? 0), 0);

    const beforeStrengthA = strength(idsA);
    const beforeStrengthB = strength(idsB);
    const afterStrengthA = strength(afterA);
    const afterStrengthB = strength(afterB);

    return {
      valueOutA: valueOf(outA),
      valueOutB: valueOf(outB),
      lineupA: { before: beforeStrengthA, after: afterStrengthA, delta: afterStrengthA - beforeStrengthA },
      lineupB: { before: beforeStrengthB, after: afterStrengthB, delta: afterStrengthB - beforeStrengthB },
      countA: outA.length,
      countB: outB.length,
    };
  }, [data, rosterA, rosterB, sendA, sendB]);

  if (!rosterA || !rosterB) return <EmptyState title="Not enough teams to trade" />;

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, pid: string) => {
    const next = new Set(set);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setter(next);
  };

  const hasTrade = sendA.size > 0 || sendB.size > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Trade analyser</h1>
          <div className="small muted">
            Judged on optimal-lineup impact using season PPG, not raw player value.
          </div>
        </div>
        {hasTrade && (
          <button
            className="btn btn-sm"
            onClick={() => {
              setSendA(new Set());
              setSendB(new Set());
            }}
          >
            Clear
          </button>
        )}
      </div>

      {analysis && hasTrade && (
        <>
          <StatTileRow>
            <StatTile
              label={`${rosterA.team.name} lineup`}
              value={fmtDelta(analysis.lineupA.delta)}
              sub={`${fmt1(analysis.lineupA.before)} → ${fmt1(analysis.lineupA.after)} pts/wk`}
              tone={
                analysis.lineupA.delta > 0.5
                  ? 'var(--success-text)'
                  : analysis.lineupA.delta < -0.5
                    ? 'var(--danger-text)'
                    : undefined
              }
            />
            <StatTile
              label={`${rosterB.team.name} lineup`}
              value={fmtDelta(analysis.lineupB.delta)}
              sub={`${fmt1(analysis.lineupB.before)} → ${fmt1(analysis.lineupB.after)} pts/wk`}
              tone={
                analysis.lineupB.delta > 0.5
                  ? 'var(--success-text)'
                  : analysis.lineupB.delta < -0.5
                    ? 'var(--danger-text)'
                    : undefined
              }
            />
            <StatTile
              label="Value out"
              value={`${analysis.valueOutA} / ${analysis.valueOutB}`}
              sub={`${analysis.countA} for ${analysis.countB} players`}
            />
            <StatTile label="Verdict" value={verdict(analysis.lineupA.delta, analysis.lineupB.delta)} />
          </StatTileRow>
          <div style={{ height: 16 }} />
        </>
      )}

      <div className="grid-2">
        <TradeSide
          label="Team A"
          rosterId={teamA}
          onChangeTeam={setTeamA}
          players={rosterA.all}
          selected={sendA}
          onToggle={(pid) => toggle(sendA, setSendA, pid)}
          onOpen={setOpenPid}
          incoming={[...sendB]}
          data={data}
        />
        <TradeSide
          label="Team B"
          rosterId={teamB}
          onChangeTeam={setTeamB}
          players={rosterB.all}
          selected={sendB}
          onToggle={(pid) => toggle(sendB, setSendB, pid)}
          onOpen={setOpenPid}
          incoming={[...sendA]}
          data={data}
        />
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function fmtDelta(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
}

function verdict(a: number, b: number): string {
  if (Math.abs(a - b) < 1) return 'Even';
  return a > b ? 'A wins' : 'B wins';
}

interface SideProps {
  label: string;
  rosterId: number;
  onChangeTeam: (id: number) => void;
  players: EnrichedPlayer[];
  selected: Set<string>;
  onToggle: (pid: string) => void;
  onOpen: (pid: string) => void;
  incoming: string[];
  data: ReturnType<typeof useLeagueData>;
}

function TradeSide({
  label,
  rosterId,
  onChangeTeam,
  players,
  selected,
  onToggle,
  onOpen,
  incoming,
  data,
}: SideProps) {
  const sorted = useMemo(
    () => [...players].sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0)),
    [players],
  );

  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <div className="group-head" style={{ position: 'static', gap: 8 }}>
        <span>{label}</span>
        <select
          className="select btn-sm"
          style={{ minHeight: 30, fontSize: 12 }}
          value={rosterId}
          onChange={(e) => onChangeTeam(Number(e.target.value))}
          aria-label={`${label} roster`}
        >
          {data.teams.map((t) => (
            <option key={t.rosterId} value={t.rosterId}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {incoming.length > 0 && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--accent-wash)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="tiny bold muted" style={{ textTransform: 'uppercase' }}>
            Receiving
          </div>
          {incoming.map((pid) => (
            <div key={pid} className="row-between small" style={{ padding: '2px 0' }}>
              <span>{playerName(data.playersById.get(pid), pid)}</span>
              <ValueChip score={data.valueIndex.byPlayer.get(pid)?.score ?? null} />
            </div>
          ))}
        </div>
      )}

      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {sorted.map((p) => {
          const isSelected = selected.has(p.pid);
          return (
            <div
              key={p.pid}
              className="row"
              style={{
                gap: 8,
                padding: '6px 12px',
                borderBottom: '1px solid var(--grid)',
                background: isSelected ? 'var(--accent-wash)' : undefined,
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(p.pid)}
                aria-label={`Trade ${p.name}`}
                style={{ width: 18, height: 18, flexShrink: 0 }}
              />
              <span className="chip chip-outline tiny" style={{ minWidth: 30, justifyContent: 'center' }}>
                {p.group ?? '?'}
              </span>
              <button
                className="grow"
                style={{ minWidth: 0, textAlign: 'left' }}
                onClick={() => onOpen(p.pid)}
              >
                <span
                  className="small"
                  style={{
                    fontWeight: 600,
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.name}
                </span>
                <span className="tiny muted">
                  {p.team || '—'} · {fmt1(data.valueIndex.byPlayer.get(p.pid)?.breakdown.ppg ?? 0)} ppg
                </span>
              </button>
              <ValueChip score={p.valueScore} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
