/**
 * Schedule — the NFL week, seen through the league's own lens.
 *
 * A bare fixture list is available anywhere. What makes this useful is the
 * overlay: for every game, which players in *this* league are involved, who
 * rosters them, what they scored under our custom scoring, and how soft each
 * defence in the game has been to face.
 *
 * That turns the schedule into a planning tool — "who do I have in the Monday
 * night game", "is anyone starting against the league's most generous defence".
 */

import { useEffect, useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { cached, TTL } from '../data/cache';
import { getSchedule, teamLogo } from '../lib/sleeper';
import { groupForPlayer } from '../lib/scoring';
import { enrichPlayer } from '../data/selectors';
import type { TeamStats } from '../lib/teamStats';
import type { MatchupIndex } from '../lib/matchup';
import { AvailabilityBadge } from '../components/AvailabilityBadge';
import type { Player } from '../lib/types';
import { PlayerModal } from '../components/PlayerModal';
import {
  EmptyState,
  MatchupChip,
  Spinner,
  StatTile,
  StatTileRow,
  fmt1,
} from '../components/primitives';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

interface Game {
  week: number;
  home: string;
  away: string;
  date: string;
  status: string;
  game_id: string;
}

/** A rostered player appearing in a given game. */
interface GamePlayer {
  pid: string;
  name: string;
  team: string;
  group: PositionGroup | null;
  points: number;
  projected: number;
  played: boolean;
  ownerName: string;
  isStarter: boolean;
  player: Player;
}

export function SchedulePage() {
  const data = useLeagueData();
  const { week, setWeek } = useLeague();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  const { selectedRosterId } = useLeague();

  useEffect(() => {
    let cancelled = false;
    setGames(null);
    setError(null);

    cached(`schedule:${data.season}`, TTL.FINAL_WEEK, () => getSchedule(data.season))
      .then((rows) => {
        if (!cancelled) setGames(rows as Game[]);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the NFL schedule.');
      });

    return () => {
      cancelled = true;
    };
  }, [data.season]);

  /** pid -> which league team rosters them, and whether they started this week. */
  const ownership = useMemo(() => {
    const map = new Map<string, { ownerName: string; isStarter: boolean }>();
    const weekData = data.weeks.get(week);

    for (const team of data.teams) {
      // Matchup lineups belong to the scoring season, so they're ignored when
      // the rosters have been overridden to a different year.
      const matchup = data.rostersOverridden
        ? undefined
        : weekData?.matchups.find((m) => m.roster_id === team.rosterId);
      const starters = new Set(
        (matchup?.starters ?? team.roster.starters ?? []).map((x) => String(x ?? '')),
      );

      const all = new Set<string>();
      for (const list of [
        matchup?.players ?? team.roster.players,
        team.roster.taxi,
        team.roster.reserve,
      ]) {
        for (const pid of list ?? []) if (pid) all.add(String(pid));
      }

      for (const pid of all) {
        map.set(pid, { ownerName: team.name, isStarter: starters.has(pid) });
      }
    }

    return map;
  }, [data, week]);

  /** Rostered players grouped by the NFL team they play for. */
  const playersByTeam = useMemo(() => {
    const map = new Map<string, GamePlayer[]>();

    for (const [pid, owner] of ownership) {
      const enriched = enrichPlayer(data, pid, week, '', owner.isStarter);
      const player = enriched.player;
      const nflTeam = enriched.team;
      if (!nflTeam) continue;

      const entry: GamePlayer = {
        pid,
        player,
        name:
          player?.full_name ??
          [player?.first_name, player?.last_name].filter(Boolean).join(' ') ??
          pid,
        team: nflTeam,
        group: groupForPlayer(player),
        points: enriched.act,
        projected: enriched.proj,
        played: enriched.hasPlayed,
        ownerName: owner.ownerName,
        isStarter: owner.isStarter,
      };

      const list = map.get(nflTeam);
      if (list) list.push(entry);
      else map.set(nflTeam, [entry]);
    }

    // Starters first, then by what they scored.
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(b.isStarter) - Number(a.isStarter) ||
          b.points - a.points ||
          b.projected - a.projected,
      );
    }

    return map;
  }, [data, ownership, week]);

  const weekGames = useMemo(
    () =>
      (games ?? [])
        .filter((g) => g.week === week && !['canceled', 'cancelled'].includes(g.status.toLowerCase()))
        .sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home)),
    [games, week],
  );

  const selectedTeamName =
    selectedRosterId !== null ? data.teamsById.get(selectedRosterId)?.name : undefined;

  const visibleGames = useMemo(() => {
    if (!onlyMine || !selectedTeamName) return weekGames;
    return weekGames.filter((g) =>
      [g.home, g.away].some((t) =>
        (playersByTeam.get(t) ?? []).some((p) => p.ownerName === selectedTeamName),
      ),
    );
  }, [weekGames, onlyMine, selectedTeamName, playersByTeam]);

  const weeks = Array.from({ length: 18 }, (_, i) => i + 1);

  // How many of the league's rostered players are on a bye this week.
  const byeCount = useMemo(() => {
    if (!weekGames.length) return 0;
    const playing = new Set<string>();
    for (const g of weekGames) {
      playing.add(g.home);
      playing.add(g.away);
    }
    let n = 0;
    for (const pid of ownership.keys()) {
      const t = (data.weeks.get(week)?.teams[pid] ?? data.playersById.get(pid)?.team ?? '').toUpperCase();
      if (t && !playing.has(t)) n++;
    }
    return n;
  }, [weekGames, ownership, data, week]);

  const teamStats = data.pregameTeamStats.get(week) ?? new Map<string, TeamStats>();
  const matchupIndex = data.pregameMatchupIndexes.get(week);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">The week ahead</p>
          <h1 className="page-title">Schedule & matchups</h1>
          <p className="page-description">Both sides of every game, with the numbers behind the matchup.</p>
          <p className="tiny muted">Player status badges show today’s status; team assignments and scores use the selected week.</p>
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Week">
          {weeks.map((w) => (
            <button key={w} aria-pressed={w === week} onClick={() => setWeek(w)}>
              {w}
            </button>
          ))}
        </div>

        {selectedTeamName && (
          <button
            className="btn btn-sm"
            aria-pressed={onlyMine}
            onClick={() => setOnlyMine((v) => !v)}
          >
            {onlyMine ? `Only ${selectedTeamName}` : 'All games'}
          </button>
        )}
      </div>

      {error && <EmptyState title={error} hint="The schedule endpoint may be unavailable." />}

      {!games && !error && <Spinner label="Loading NFL schedule…" />}

      {games && weekGames.length === 0 && (
        <EmptyState title={`No games scheduled for week ${week}`} />
      )}

      {games && weekGames.length > 0 && (
        <>
          <StatTileRow>
            <StatTile label="Games" value={String(weekGames.length)} />
            <StatTile
              label="Players on scheduled teams"
              value={String(
                weekGames.reduce(
                  (n, g) =>
                    n +
                    (playersByTeam.get(g.home)?.length ?? 0) +
                    (playersByTeam.get(g.away)?.length ?? 0),
                  0,
                ),
              )}
            />
            <StatTile label="On bye" value={String(byeCount)} />
          </StatTileRow>

          <div style={{ height: 16 }} />

          <div className="stack">
            {visibleGames.map((game) => (
              <GameCard
                key={game.game_id}
                game={game}
                playersByTeam={playersByTeam}
                teamStats={teamStats}
                matchupIndex={matchupIndex}
                week={week}
                matchupFor={(defense, group) =>
                  matchupIndex?.get(group, defense)?.score ?? null
                }
                onSelect={setOpenPid}
                highlightOwner={onlyMine ? selectedTeamName : undefined}
              />
            ))}
            {visibleGames.length === 0 && (
              <EmptyState
                title="No games involve your players this week"
                hint="Switch back to All games."
              />
            )}
          </div>
        </>
      )}

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function GameCard({
  game,
  playersByTeam,
  matchupFor,
  onSelect,
  highlightOwner,
  teamStats,
  matchupIndex,
  week,
}: {
  game: Game;
  playersByTeam: Map<string, GamePlayer[]>;
  matchupFor: (defense: string, group: PositionGroup) => number | null;
  onSelect: (pid: string) => void;
  highlightOwner?: string;
  teamStats: Map<string, TeamStats>;
  matchupIndex?: MatchupIndex;
  week: number;
}) {
  const home = playersByTeam.get(game.home) ?? [];
  const away = playersByTeam.get(game.away) ?? [];

  const date = new Date(`${game.date}T00:00:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? game.date
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const total = (list: GamePlayer[]) =>
    list.reduce((s, p) => s + (p.played ? p.points : 0), 0);

  return (
    <section className="card schedule-card" style={{ overflow: 'hidden' }}>
      <header className="group-head group-head--primary">
        <span className="row" style={{ gap: 8 }}>
          <TeamMark team={game.away} />
          <span>{game.away}</span>
          <span className="muted" style={{ textTransform: 'none', fontWeight: 500 }}>
            at
          </span>
          <TeamMark team={game.home} />
          <span>{game.home}</span>
        </span>
        <span className="tiny muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {dateLabel}
          {game.status === 'complete' ? ' · final' : ''}
        </span>
      </header>

      <MatchupStats home={game.home} away={game.away} week={week} teams={teamStats} index={matchupIndex} />

      <div className="game-grid">
        <TeamSide
          team={game.away}
          opponent={game.home}
          players={away}
          total={total(away)}
          matchupFor={matchupFor}
          onSelect={onSelect}
          highlightOwner={highlightOwner}
        />
        <TeamSide
          team={game.home}
          opponent={game.away}
          players={home}
          total={total(home)}
          matchupFor={matchupFor}
          onSelect={onSelect}
          highlightOwner={highlightOwner}
        />
      </div>
    </section>
  );
}

function TeamMark({ team }: { team: string }) {
  return (
    <img
      src={teamLogo(team)}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      style={{ objectFit: 'contain' }}
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

function TeamSide({
  team,
  opponent,
  players,
  total,
  matchupFor,
  onSelect,
  highlightOwner,
}: {
  team: string;
  opponent: string;
  players: GamePlayer[];
  total: number;
  matchupFor: (defense: string, group: PositionGroup) => number | null;
  onSelect: (pid: string) => void;
  highlightOwner?: string;
}) {
  return (
    <div className="game-side">
      <div className="row-between" style={{ padding: '8px 12px 4px' }}>
        <span className="row" style={{ gap: 6 }}>
          <TeamMark team={team} />
          <span className="bold small">{team}</span>
        </span>
        {players.length > 0 && (
          <span className="mono small">{fmt1(total)}</span>
        )}
      </div>

      {players.length === 0 ? (
        <div className="tiny muted" style={{ padding: '4px 12px 10px' }}>
          No rostered players
        </div>
      ) : (
        players.map((p) => (
          <button
            key={p.pid}
            className="game-player"
            onClick={() => onSelect(p.pid)}
            style={
              highlightOwner && p.ownerName === highlightOwner
                ? { background: 'var(--accent-wash)' }
                : undefined
            }
          >
            <span className="chip chip-outline tiny" style={{ minWidth: 28, justifyContent: 'center' }}>
              {p.group ?? '?'}
            </span>
            <span className="game-player__name">
              <span className="small" style={{ fontWeight: p.isStarter ? 700 : 500 }}>
                {p.name}
              </span>
              <span className="tiny muted">{p.ownerName}</span>
              <span className="row wrap" style={{ gap: 4 }}><AvailabilityBadge player={p.player} /></span>
            </span>
            <MatchupChip score={p.group ? matchupFor(opponent, p.group) : null} group={p.group} />
            <span className="mono small bold" style={{ minWidth: 42, textAlign: 'right' }}>
              {p.played ? fmt1(p.points) : fmt1(p.projected)}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

/** Position groups, re-exported for the filter UI if it grows. */
export { POSITION_GROUPS };

function MatchupStats({ home, away, week, teams, index }: {
  home: string; away: string; week: number; teams: Map<string, TeamStats>; index?: MatchupIndex;
}) {
  const [group, setGroup] = useState<PositionGroup>('QB');
  const homeAllowed = index?.get(group, home);
  const awayAllowed = index?.get(group, away);
  const homeStats = teams.get(home);
  const awayStats = teams.get(away);
  const format = (value: number | null | undefined) => value == null ? '—' : fmt1(value);
  const rows: Array<[string, number | null | undefined, number | null | undefined]> = [
    ['Passing yards / game', awayStats?.passYards, homeStats?.passYards],
    ['Rushing yards / game', awayStats?.rushYards, homeStats?.rushYards],
    ['Pass attempts / game', awayStats?.passAttempts, homeStats?.passAttempts],
    ['Rush attempts / game', awayStats?.rushAttempts, homeStats?.rushAttempts],
    ['Sacks taken / game', awayStats?.sacksTaken, homeStats?.sacksTaken],
  ];
  return <div className="matchup-preview">
    <div className="row-between wrap" style={{ gap: 8 }}>
      <h3 className="small bold">Pregame comparison</h3>
      <span className="tiny muted">{index?.season ? `${index.season} stats · Through week ${index.throughWeek}` : `Before week ${week}`}</span>
    </div>
    <table className="context-table matchup-table">
      <thead><tr><th>Team offense</th><th>{away}</th><th>{home}</th></tr></thead>
      <tbody>{rows.map(([label, a, h]) => <tr key={label}><th scope="row">{label}</th><td>{format(a)}</td><td>{format(h)}</td></tr>)}</tbody>
    </table>
    <div className="row-between wrap" style={{ marginTop: 12, gap: 8 }}>
      <label className="small bold" htmlFor={`position-${away}-${home}`}>Opponent allowance by position</label>
      <select className="select" id={`position-${away}-${home}`} value={group} onChange={(e) => setGroup(e.target.value as PositionGroup)}>
        {POSITION_GROUPS.map((position) => <option key={position}>{position}</option>)}
      </select>
    </div>
    <table className="context-table matchup-table">
      <thead><tr><th>{group} matchup</th><th>{away} faces {home}</th><th>{home} faces {away}</th></tr></thead>
      <tbody>
        <tr><th scope="row">Matchup rating</th><td><MatchupChip score={homeAllowed?.score ?? null} group={group} /></td><td><MatchupChip score={awayAllowed?.score ?? null} group={group} /></td></tr>
        <tr><th scope="row">Custom points allowed / game</th><td>{format(homeAllowed?.pointsPerGame)}</td><td>{format(awayAllowed?.pointsPerGame)}</td></tr>
        <tr><th scope="row">Schedule-adjusted points / game</th><td>{format(homeAllowed?.opponentAdjustedPpg)}</td><td>{format(awayAllowed?.opponentAdjustedPpg)}</td></tr>
        <tr><th scope="row">Last 4 points / game</th><td>{format(homeAllowed?.last4)}</td><td>{format(awayAllowed?.last4)}</td></tr>
        <tr><th scope="row">Games sampled</th><td>{homeAllowed?.games ?? '—'}</td><td>{awayAllowed?.games ?? '—'}</td></tr>
      </tbody>
    </table>
  </div>;
}
