/**
 * Small shared display primitives.
 *
 * The one rule these all follow: a colour never carries meaning by itself.
 * Every status ships an icon and a text label, and every coloured chip prints
 * its own number, so the display stays readable under colour-vision deficiency,
 * greyscale printing and forced-colours mode.
 */

import { useTheme } from './ThemeProvider';
import { matchupScoreFill, rankFill, valueScoreFill } from '../lib/colors';
import { statusTone } from '../lib/status';
import type { PlayerStatus, RankInfo, StatusLabel } from '../lib/types';

/** Icon per status — the secondary channel that makes colour non-essential. */
const STATUS_ICON: Record<StatusLabel, string> = {
  'Major Boom': '▲▲',
  Boom: '▲',
  'In Range': '—',
  Bust: '▼',
  'Major Bust': '▼▼',
  'Not Played': '·',
  'No Proj': '·',
};

export function StatusBadge({ status, compact }: { status: PlayerStatus; compact?: boolean }) {
  const tone = statusTone(status.label);
  return (
    <span
      className="chip"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
      title={status.label}
    >
      <span aria-hidden="true">{STATUS_ICON[status.label]}</span>
      {!compact && status.label}
    </span>
  );
}

/**
 * Value Score chip (0–1000).
 *
 * Sequential single-hue fill for magnitude; the number itself sits in whichever
 * ink contrasts against the generated fill rather than being colour-coded.
 */
export function ValueChip({ score, label = 'VAL' }: { score: number | null; label?: string }) {
  const { mode } = useTheme();
  const { background, ink } = valueScoreFill(score, mode);

  return (
    <span
      className="chip mono"
      style={{ background, color: ink }}
      title={`${label} ${score ?? '—'} of 1000`}
    >
      {score === null ? '—' : score}
    </span>
  );
}

/** Matchup Score chip (0–100). Higher means a softer defence to face. */
export function MatchupChip({ score }: { score: number | null }) {
  const { mode } = useTheme();
  const { background, ink } = matchupScoreFill(score, mode);

  return (
    <span
      className="chip mono"
      style={{ background, color: ink }}
      title={
        score === null
          ? 'No matchup data'
          : `Matchup ${score} of 100 — softer than ${Math.round(score)}% of defences`
      }
    >
      {score === null ? '—' : Math.round(score)}
    </span>
  );
}

/**
 * Positional rank pill, e.g. "#11 Total" or "#20 PPG".
 *
 * Tier colour comes from the rank's quartile within its own position pool, so a
 * WR ranked 20th of 300 reads green while a kicker ranked 20th of 32 does not.
 * The rank number is always printed, so the colour is reinforcement only.
 */
export function RankPill({ rank, kind }: { rank: RankInfo | null; kind: 'Total' | 'PPG' }) {
  const { mode } = useTheme();
  if (!rank) return null;

  const { background, ink } = rankFill(rank.rank, rank.outOf, mode);

  return (
    <span
      className="chip mono"
      style={{ background, color: ink }}
      title={`${rank.group} rank ${rank.rank} of ${rank.outOf} by ${
        kind === 'PPG' ? 'points per game' : 'total points'
      }`}
    >
      #{rank.rank}
      {/* The word collapses to a single letter in narrow containers so the
          pills still fit beside the name on a phone. */}
      <span className="chip__long">{kind}</span>
      <span className="chip__short">{kind === 'PPG' ? 'P' : 'T'}</span>
    </span>
  );
}

/** A single headline number with its label. */
export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="card card-pad" style={{ minWidth: 0 }}>
      <div className="tiny muted bold" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, color: tone ?? 'var(--text-primary)' }}
      >
        {value}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

export function StatTileRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 10,
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      }}
    >
      {children}
    </div>
  );
}

/** Position group badge. */
export function PosBadge({ group, slot }: { group: string | null; slot?: string }) {
  const text = slot && slot !== group ? slot.replace(/_/g, ' ') : (group ?? '—');
  return (
    <span className="chip chip-outline" style={{ minWidth: 34, justifyContent: 'center' }}>
      {text}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10, padding: 24, justifyContent: 'center' }}>
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          border: '2px solid var(--border-strong)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span className="muted small">{label ?? 'Loading…'}</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card card-pad" style={{ textAlign: 'center', padding: 32 }}>
      <div className="bold">{title}</div>
      {hint && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Formats a score to one decimal place, or an em dash when absent. */
export function fmt1(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(1);
}

export function fmtSigned(n: number): string {
  const s = n.toFixed(1);
  return n > 0 ? `+${s}` : s;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${(n * 100).toFixed(digits)}%`;
}
