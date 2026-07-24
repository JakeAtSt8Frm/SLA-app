import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Mode } from '../lib/colors';

type Preference = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  /** The mode actually being rendered, after resolving "system". */
  mode: Mode;
  preference: Preference;
  setPreference: (p: Preference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'sla.theme';

function readPreference(): Preference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function systemMode(): Mode {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Theme state.
 *
 * The rendered mode is exposed to JS because the heatmap and chip fills are
 * computed at runtime — CSS custom properties alone can't drive them, since the
 * colours depend on data values as well as on the theme.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<Preference>(readPreference);
  const [resolved, setResolved] = useState<Mode>(() =>
    preference === 'system' ? systemMode() : preference,
  );

  // Track the OS setting while the preference is "system".
  useEffect(() => {
    if (preference !== 'system') {
      setResolved(preference);
      return;
    }

    setResolved(systemMode());
    if (typeof matchMedia === 'undefined') return;

    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  // Stamp the root so the CSS token overrides apply.
  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
  }, [preference]);

  const setPreference = useCallback((p: Preference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* non-fatal */
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setPreference]);

  const value = useMemo(
    () => ({ mode: resolved, preference, setPreference, toggle }),
    [resolved, preference, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx;
}
