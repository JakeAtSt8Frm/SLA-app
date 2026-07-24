import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TeamsPage } from './pages/Teams';
import { OptimalPage } from './pages/Optimal';
import { HistoryPage } from './pages/History';
import { PlayersPage } from './pages/Players';
import { SchedulePage } from './pages/Schedule';
import { AnalyticsPage } from './pages/Analytics';

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
