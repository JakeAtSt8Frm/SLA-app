import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './components/ThemeProvider';
import { LeagueProvider } from './data/LeagueProvider';
import './styles/global.css';
import './styles/components.css';

/*
 * HashRouter rather than BrowserRouter: this deploys to GitHub Pages, which
 * serves static files with no rewrite rules, so a deep link like /history would
 * 404 on refresh under a browser router. It also matches the old site's URLs
 * (#teams, #history), so existing bookmarks keep working.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LeagueProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </LeagueProvider>
    </ThemeProvider>
  </StrictMode>,
);
