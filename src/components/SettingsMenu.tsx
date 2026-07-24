/**
 * Settings popover.
 *
 * Currently one setting, but the one that needed somewhere to live: viewing a
 * different season's rosters against the selected season's scoring. That answers
 * "how would this year's roster have done against last year's actual results" —
 * useful after a draft, when the new season has rosters but no games yet.
 */

import { useEffect, useRef } from 'react';
import { useLeague } from '../data/LeagueProvider';
import { SEASONS } from '../data/league';

export function SettingsMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { season, rosterSeason, setRosterSeason, data } = useLeague();
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape or a click outside the panel.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener('keydown', onKey);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(id);
    };
  }, [open, onClose]);

  if (!open) return null;

  const overridden = rosterSeason !== season;

  return (
    <div className="settings" ref={ref} role="dialog" aria-label="Settings">
      <div className="settings__title">Settings</div>

      <label className="settings__field">
        <span className="settings__label">Roster season</span>
        <select
          className="select"
          value={rosterSeason}
          onChange={(e) => setRosterSeason(e.target.value)}
        >
          {SEASONS.map((s) => (
            <option key={s} value={s}>
              {s}
              {s === season ? ' (same as scoring)' : ''}
            </option>
          ))}
        </select>
      </label>

      <p className="settings__hint">
        Scoring, stats and results come from <strong>{season}</strong>.
        {overridden ? (
          <>
            {' '}
            Rosters are being read from <strong>{rosterSeason}</strong>, so each team's
            players are their {rosterSeason} squad scored against {season} results.
          </>
        ) : (
          ' Rosters follow the same season.'
        )}
      </p>

      {overridden && (
        <>
          <p className="settings__warn">
            Records, playoff results and the champion are hidden while rosters are
            overridden — they belong to {season}'s teams, not {rosterSeason}'s.
          </p>
          <button className="btn btn-sm" onClick={() => setRosterSeason(season)}>
            Reset to {season} rosters
          </button>
        </>
      )}

      {data?.rosterLeague && (
        <div className="settings__meta tiny muted">
          Roster league: {data.rosterLeague.name} ({data.rosterLeague.status.replace(/_/g, ' ')})
        </div>
      )}
    </div>
  );
}
