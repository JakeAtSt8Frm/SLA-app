/**
 * Application shell: header controls on every screen, plus navigation that
 * adapts to the viewport — a horizontal tab strip on desktop, a fixed bottom
 * tab bar on phones (thumb-reachable, matching platform convention on iOS).
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useLeague } from '../data/LeagueProvider';
import { useTheme } from './ThemeProvider';
import { SEASONS } from '../data/league';
import { Spinner } from './primitives';

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: string;
}

const NAV: NavItem[] = [
  { to: '/teams', label: 'Teams', short: 'Teams', icon: '▣' },
  { to: '/matchups', label: 'Matchups', short: 'Match', icon: '⚔' },
  { to: '/optimal', label: 'Optimal Lineup', short: 'Optimal', icon: '✦' },
  { to: '/analytics', label: 'Analytics', short: 'Stats', icon: '◨' },
  { to: '/history', label: 'History', short: 'History', icon: '◷' },
  { to: '/trade', label: 'Trade', short: 'Trade', icon: '⇄' },
  { to: '/players', label: 'Players', short: 'Players', icon: '⌕' },
];

export function AppShell() {
  const { status, data, error, progress, season, setSeason, week, setWeek, refresh } = useLeague();
  const { mode, toggle } = useTheme();

  const weeks = data ? Array.from({ length: data.maxWeek }, (_, i) => i + 1) : [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <span className="brand">SLA</span>
            <span className="topbar__league">
              {data ? data.league.name : 'Loading…'}
              {data && (
                <span className="tiny muted" style={{ display: 'block', lineHeight: 1.2 }}>
                  {data.league.total_rosters} teams · {data.starterSlots.length} starters ·{' '}
                  {data.scoringModel.keys.length} scoring keys
                </span>
              )}
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <label className="sr-only" htmlFor="season-select">
              Season
            </label>
            <select
              id="season-select"
              className="select"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
            >
              {SEASONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            {weeks.length > 0 && (
              <>
                <label className="sr-only" htmlFor="week-select">
                  Week
                </label>
                <select
                  id="week-select"
                  className="select"
                  value={week}
                  onChange={(e) => setWeek(Number(e.target.value))}
                >
                  {weeks.map((w) => (
                    <option key={w} value={w}>
                      Week {w}
                    </option>
                  ))}
                </select>
              </>
            )}

            <button
              className="btn btn-ghost btn-sm"
              onClick={toggle}
              aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`}
            >
              {mode === 'dark' ? '☀' : '☾'}
            </button>

            <button
              className="btn btn-ghost btn-sm"
              onClick={refresh}
              aria-label="Refresh data"
              title="Clear cache and reload"
            >
              ⟳
            </button>
          </div>
        </div>

        <nav className="tabs" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `tabs__link${isActive ? ' is-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="page">
        {status === 'loading' && (
          <div style={{ paddingTop: 48 }}>
            <Spinner label={progress ? `${progress.phase}…` : 'Loading league…'} />
            {progress && progress.total > 1 && (
              <div className="progress" role="progressbar" aria-valuenow={progress.loaded} aria-valuemin={0} aria-valuemax={progress.total}>
                <span style={{ width: `${(progress.loaded / progress.total) * 100}%` }} />
              </div>
            )}
            <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
              First load pulls a full season of stats. It's cached after this.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="card card-pad" style={{ marginTop: 32 }}>
            <h2 className="bold">Couldn't load the league</h2>
            <p className="small muted" style={{ marginTop: 6 }}>
              {error}
            </p>
            <button className="btn" style={{ marginTop: 12 }} onClick={refresh}>
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && data && data.maxWeek === 0 && (
          <div className="card card-pad" style={{ marginTop: 32 }}>
            <h2 className="bold">{data.league.name} hasn't started yet</h2>
            <p className="small muted" style={{ marginTop: 6 }}>
              This league is still in {data.league.status.replace(/_/g, ' ')}. Pick an earlier
              season above to see results.
            </p>
          </div>
        )}

        {status === 'ready' && data && data.maxWeek > 0 && <Outlet />}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `bottom-nav__link${isActive ? ' is-active' : ''}`}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="bottom-nav__label">{item.short}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
