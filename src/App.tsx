import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';

/*
 * Pages are loaded on demand.
 *
 * The landing route is Teams, but a static import graph makes every page's cost
 * part of the first paint — and the pages are not the same size. Analytics alone
 * pulls in the Monte Carlo simulator and the playoff bracket resolver, neither of
 * which a reader checking a lineup ever runs. Splitting at the route lets each
 * page's code arrive when it is first visited, which on a phone on stadium wifi
 * is the difference that matters.
 *
 * Recharts is already split beneath this (see LazyChart), so a page that draws
 * charts fetches two small chunks rather than one large one.
 */
const TeamsPage = lazy(() => import('./pages/Teams').then((m) => ({ default: m.TeamsPage })));
const OptimalPage = lazy(() =>
  import('./pages/Optimal').then((m) => ({ default: m.OptimalPage })),
);
const HistoryPage = lazy(() =>
  import('./pages/History').then((m) => ({ default: m.HistoryPage })),
);
const PlayersPage = lazy(() =>
  import('./pages/Players').then((m) => ({ default: m.PlayersPage })),
);
const SchedulePage = lazy(() =>
  import('./pages/Schedule').then((m) => ({ default: m.SchedulePage })),
);
const AnalyticsPage = lazy(() =>
  import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })),
);

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/teams" replace />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="optimal" element={<OptimalPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="players" element={<PlayersPage />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        {/* Routes that existed before the nav was trimmed. */}
        <Route path="matchups" element={<Navigate to="/teams" replace />} />
        <Route path="trade" element={<Navigate to="/players" replace />} />
        <Route path="*" element={<Navigate to="/teams" replace />} />
      </Route>
    </Routes>
  );
}
