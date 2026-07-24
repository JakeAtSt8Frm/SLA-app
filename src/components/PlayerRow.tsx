/**
 * A player as a row in a list.
 *
 * The original app used large cards. With 21 starting slots plus a deep bench,
 * cards meant a lot of scrolling on a phone, so the default is a dense row that
 * still carries every number a card did: projection, actual, boom/bust state,
 * Value Score, matchup rating and positional ranks.
 *
 * Identity and standing sit together on the top line — name, then Value, then
 * the rank pills — so a player can be judged without reading downward. The
 * second line is only context (team, opponent).
 */

import { playerHeadshot, teamLogo } from '../lib/sleeper';
import {
  MatchupChip,
  PosBadge,
  RankPill,
  StatusBadge,
  ValueChip,
  fmt1,
} from './primitives';
import type { EnrichedPlayer } from '../lib/types';

interface Props {
  player: EnrichedPlayer;
  onSelect?: (pid: string) => void;
  /** Show the projection column. Hidden on views that only report results. */
  showProjection?: boolean;
  /** Extra context appended to the second line, e.g. the rostering team. */
  note?: string | null;
}

/** Headshot that falls back to the team logo, then hides itself. */
function Avatar({ pid, team, size }: { pid: string; team: string; size: number }) {
  return (
    <img
      src={playerHeadshot(pid)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="avatar"
      style={{ width: size, height: size }}
      onError={(e) => {
        const img = e.currentTarget;
        const fallback = teamLogo(team);
        if (fallback && img.src !== fallback) img.src = fallback;
        else img.style.visibility = 'hidden';
      }}
    />
  );
}

export function PlayerRow({ player: p, onSelect, showProjection = true, note }: Props) {
  const delta = p.hasPlayed && p.proj > 0 ? p.act - p.proj : null;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(p.pid)}
      className="player-row"
      aria-label={`${p.name}, ${p.group ?? 'unknown position'}, ${
        p.hasPlayed ? `scored ${fmt1(p.act)}` : `projected ${fmt1(p.proj)}`
      }`}
    >
      <PosBadge group={p.group} slot={p.slot} />

      <Avatar pid={p.pid} team={p.team} size={34} />

      <span className="player-row__id">
        <span className="player-row__title">
          <span className="player-row__name">{p.name}</span>
          <ValueChip score={p.valueScore} />
          <RankPill rank={p.totalRank} kind="Total" />
          <RankPill rank={p.ppgRank} kind="PPG" />
          <MatchupChip score={p.matchupScore} />
          {p.isOut && (
            <span className="chip" style={{ color: 'var(--danger-text)' }}>
              OUT
            </span>
          )}
        </span>
        <span className="tiny muted">
          {p.team || '—'}
          {p.opponent ? ` vs ${p.opponent}` : ''}
          {note ? ` · ${note}` : ''}
        </span>
      </span>

      {showProjection && (
        <span className="player-row__num mono" title="Projected Score">
          {fmt1(p.proj)}
        </span>
      )}

      <span className="player-row__num mono bold" title="Actual Score">
        {p.hasPlayed ? fmt1(p.act) : '—'}
      </span>

      <span className="player-row__status">
        {delta !== null && (
          <span
            className="tiny mono"
            style={{ color: delta >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}
          >
            {delta >= 0 ? '+' : ''}
            {delta.toFixed(1)}
          </span>
        )}
        <StatusBadge status={p.status} compact />
      </span>
    </button>
  );
}

/** Card layout — used where a player is the subject rather than a list entry. */
export function PlayerCard({ player: p, onSelect }: Props) {
  return (
    <button type="button" onClick={() => onSelect?.(p.pid)} className="player-card">
      <div className="row" style={{ gap: 10 }}>
        <Avatar pid={p.pid} team={p.team} size={42} />
        <div className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
          <div className="bold" style={{ fontSize: 14, lineHeight: 1.3 }}>
            {p.name}
          </div>
          <div className="tiny muted">
            {p.group} · {p.team || '—'}
            {p.opponent ? ` vs ${p.opponent}` : ''}
          </div>
        </div>
        <PosBadge group={p.group} slot={p.slot} />
      </div>

      <div className="player-card__scores">
        <div>
          <div className="tiny muted">Projected Score</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {fmt1(p.proj)}
          </div>
        </div>
        <div>
          <div className="tiny muted">Actual Score</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {p.hasPlayed ? fmt1(p.act) : '—'}
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <ValueChip score={p.valueScore} />
        <RankPill rank={p.totalRank} kind="Total" />
        <RankPill rank={p.ppgRank} kind="PPG" />
        <MatchupChip score={p.matchupScore} />
        <StatusBadge status={p.status} />
      </div>
    </button>
  );
}
