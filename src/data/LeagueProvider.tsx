import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadLeague, SEASON_LEAGUES, type LeagueData, type LoadProgress } from './league';
import { cacheClear } from './cache';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface LeagueContextValue {
  status: Status;
  data: LeagueData | null;
  error: string | null;
  progress: LoadProgress | null;
  season: string;
  setSeason: (season: string) => void;
  /** Week the user is currently viewing. */
  week: number;
  setWeek: (week: number) => void;
  /** Roster the user has selected, defaults to the first team. */
  selectedRosterId: number | null;
  setSelectedRosterId: (id: number) => void;
  refresh: () => void;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

const SEASON_KEY = 'sla.season';

function initialSeason(): string {
  try {
    const saved = localStorage.getItem(SEASON_KEY);
    if (saved && SEASON_LEAGUES[saved]) return saved;
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  // 2025 is the most recent season with a full set of results; the 2026 league
  // is still pre-draft, so defaulting there would show an empty app.
  return '2025';
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [season, setSeasonState] = useState(initialSeason);
  const [status, setStatus] = useState<Status>('idle');
  const [data, setData] = useState<LeagueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [week, setWeek] = useState(1);
  const [selectedRosterId, setSelectedRosterId] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus('loading');
    setError(null);
    setProgress(null);

    loadLeague(
      season,
      (p) => {
        if (!cancelled) setProgress(p);
      },
      controller.signal,
    )
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setWeek(result.currentWeek);
        setSelectedRosterId((prev) =>
          prev !== null && result.teamsById.has(prev)
            ? prev
            : (result.teams[0]?.rosterId ?? null),
        );
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load league data');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [season, reloadToken]);

  const setSeason = useCallback((next: string) => {
    setSeasonState(next);
    try {
      localStorage.setItem(SEASON_KEY, next);
    } catch {
      /* non-fatal */
    }
  }, []);

  const refresh = useCallback(() => {
    void cacheClear().then(() => setReloadToken((n) => n + 1));
  }, []);

  const value = useMemo<LeagueContextValue>(
    () => ({
      status,
      data,
      error,
      progress,
      season,
      setSeason,
      week,
      setWeek,
      selectedRosterId,
      setSelectedRosterId,
      refresh,
    }),
    [status, data, error, progress, season, setSeason, week, selectedRosterId, refresh],
  );

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeague must be used inside a LeagueProvider');
  return ctx;
}

/**
 * Convenience hook for pages that only render once data is ready.
 * Throws if called before load completes, so callers can rely on non-null data.
 */
export function useLeagueData(): LeagueData {
  const { data } = useLeague();
  if (!data) throw new Error('League data is not loaded yet');
  return data;
}
