import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TeamsPage } from './pages/Teams';
import { MatchupsPage } from './pages/Matchups';
import { OptimalPage } from './pages/Optimal';
import { AnalyticsPage } from './pages/Analytics';
import { HistoryPage } from './pages/History';
import { TradePage } from './pages/Trade';
import { PlayersPage } from './pages/Players';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/teams" replace />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="matchups" element={<MatchupsPage />} />
        <Route path="optimal" element={<OptimalPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="trade" element={<TradePage />} />
        <Route path="players" element={<PlayersPage />} />
        <Route path="*" element={<Navigate to="/teams" replace />} />
      </Route>
    </Routes>
  );
}
