/**
 * Players — searchable browser over everyone, rostered or free.
 *
 * Defaults to free agents because that's the actionable list, but the whole
 * league is searchable. The default ranking is the market-independent,
 * cross-position dynasty intrinsic score.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { enrichPlayer, rosteredIds } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState } from '../components/primitives';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

type Availability = 'free' | 'rostered' | 'all';
type SortKey = 'value' | 'ppg' | 'total' | 'last4';

export function PlayersPage() {
  const data = useLeagueData();
  const [group, setGroup] = useState<PositionGroup | 'ALL'>('ALL');
  const [availability, setAvailability] = useState<Availability>('free');
  const [sort, setSort] = useState<SortKey>('value');
  const [query, setQuery] = useState('');
  const [openPid, setOpenPid] = useState<string | null>(null);

  // Keeps typing responsive while the list re-filters.
  const deferredQuery = useDeferredValue(query);

  const owned = useMemo(() => rosteredIds(data), [data]);

  const ownerByPid = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of data.teams) {
      for (const pid of team.roster.players ?? []) {
        if (pid) map.set(String(pid), team.name);
      }
    }
    return map;
  }, [data]);

  const results = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const rows: Array<{ pid: string; sortValue: number }> = [];

    const pids = new Set([
      ...data.valueIndex.byPlayer.keys(),
      ...data.dynastyIndex.byPlayer.keys(),
    ]);
    for (const pid of pids) {
      const current = data.valueIndex.byPlayer.get(pid);
      const dynasty = data.dynastyIndex.byPlayer.get(pid);
      const playerGroup = dynasty?.group ?? current?.group;
      if (!playerGroup || (group !== 'ALL' && playerGroup !== group)) continue;

      const isOwned = owned.has(pid);
      if (availability === 'free' && isOwned) continue;
      if (availability === 'rostered' && !isOwned) continue;

      if (needle) {
        const player = data.playersById.get(pid);
        const name = (
          player?.full_name ?? `${player?.first_name ?? ''} ${player?.last_name ?? ''}`
        ).toLowerCase();
        const team = (player?.team ?? '').toLowerCase();
        if (!name.includes(needle) && !team.includes(needle)) continue;
      }

      const sortValue =
        sort === 'value'
          ? (data.headlineScores.get(pid) ?? 0)
          : sort === 'ppg'
            ? (current?.breakdown.ppg ?? 0)
            : sort === 'total'
              ? (current?.breakdown.total ?? 0)
              : (current?.breakdown.last4 ?? 0);

      rows.push({ pid, sortValue });
    }

    rows.sort((a, b) => b.sortValue - a.sortValue);
    // Cap the render — a full unfiltered list is ~1800 rows and nobody scrolls
    // past the first hundred.
    return rows.slice(0, 150).map((r) => ({
      player: enrichPlayer(
        data,
        r.pid,
        data.currentWeek,
        data.dynastyIndex.byPlayer.get(r.pid)?.group ??
          data.valueIndex.byPlayer.get(r.pid)?.group ??
          '',
        false,
      ),
      owner: ownerByPid.get(r.pid) ?? null,
    }));
  }, [data, group, availability, sort, deferredQuery, owned, ownerByPid]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Available Players</h1>
      </div>

      <div className="filters">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search name or team…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search players"
        />

        <div className="segmented" role="group" aria-label="Availability">
          <button aria-pressed={availability === 'free'} onClick={() => setAvailability('free')}>
            Free agents
          </button>
          <button
            aria-pressed={availability === 'rostered'}
            onClick={() => setAvailability('rostered')}
          >
            Rostered
          </button>
          <button aria-pressed={availability === 'all'} onClick={() => setAvailability('all')}>
            All
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Sort by">
          <button aria-pressed={sort === 'value'} onClick={() => setSort('value')}>
            Value
          </button>
          <button aria-pressed={sort === 'ppg'} onClick={() => setSort('ppg')}>
            PPG
          </button>
          <button aria-pressed={sort === 'total'} onClick={() => setSort('total')}>
            Total
          </button>
          <button aria-pressed={sort === 'last4'} onClick={() => setSort('last4')}>
            Last 4
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Position group">
          <button aria-pressed={group === 'ALL'} onClick={() => setGroup('ALL')}>
            All
          </button>
          {POSITION_GROUPS.map((g) => (
            <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          title="No players match"
          hint="Try a different position group or clear the search."
        />
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>
              {results.length} shown
              {results.length === 150 ? ' (top 150)' : ''}
            </span>
          </div>
          {results.map(({ player, owner }) => (
            <PlayerRow
              key={player.pid}
              player={player}
              onSelect={setOpenPid}
              note={owner}
            />
          ))}
        </section>
      )}

      <PlayerModal pid={openPid} week={data.currentWeek} onClose={() => setOpenPid(null)} />
    </>
  );
}
