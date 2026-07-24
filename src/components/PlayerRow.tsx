/**
 * A player as a row in a list.
 *
 * The original app used large cards. With 21 starting slots plus a 20-deep
 * bench, cards meant a lot of scrolling on a phone, so the default is a dense
 * row that still carries every number a card did: projection, actual, boom/bust
 * state, Value Score, matchup rating and positional rank. A card layout is
 * still available via `PlayerCard` for the compare and trade views.
 */

import { playerHeadshot, teamLogo } from '../lib/sleeper';
import { MatchupChip, PosBadge, StatusBadge, ValueChip, fmt1 } from './primitives';
import type { EnrichedPlayer } from '../lib/types';

interface Props {
  player: EnrichedPlayer;
  onSelect?: (pid: string) => void;
  /** Show the projection column. Hidden on views that only report results. */
  showProjection?: boolean;
}

export function PlayerRow({ player: p, onSelect, showProjection = true }: Props) {
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

      <img
        src={playerHeadshot(p.pid)}
        alt=""
        className="player-row__avatar"
        loading="lazy"
        onError={(e) => {
          const img = e.currentTarget;
          const fallback = teamLogo(p.team);
          if (fallback && img.src !== fallback) img.src = fallback;
          else img.style.visibility = 'hidden';
        }}
      />

      <span className="player-row__id">
        <span className="player-row__name">
          {p.name}
          {p.isOut && (
            <span className="chip" style={{ color: 'var(--danger-text)', marginLeft: 6 }}>
              OUT
            </span>
          )}
        </span>
        <span className="tiny muted">
          {p.team || '—'}
          {p.opponent ? ` vs ${p.opponent}` : ''}
          {p.ppgRank ? ` · ${p.group}${p.ppgRank.rank} PPG` : ''}
        </span>
      </span>

      <span className="player-row__metrics">
        <ValueChip score={p.valueScore} />
        <MatchupChip score={p.matchupScore} />
      </span>

      {showProjection && (
        <span className="player-row__num mono" title="Projected custom score">
          {fmt1(p.proj)}
        </span>
      )}

      <span className="player-row__num mono bold" title="Actual custom score">
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
        <img
          src={playerHeadshot(p.pid)}
          alt=""
          className="player-card__avatar"
          loading="lazy"
          onError={(e) => {
            const img = e.currentTarget;
            const fallback = teamLogo(p.team);
            if (fallback && img.src !== fallback) img.src = fallback;
            else img.style.visibility = 'hidden';
          }}
        />
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
          <div className="tiny muted">Projected</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {fmt1(p.proj)}
          </div>
        </div>
        <div>
          <div className="tiny muted">Actual</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {p.hasPlayed ? fmt1(p.act) : '—'}
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <ValueChip score={p.valueScore} />
        <MatchupChip score={p.matchupScore} />
        <StatusBadge status={p.status} />
      </div>
    </button>
  );
}
