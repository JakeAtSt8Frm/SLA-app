/**
 * Lazily-loaded chart wrappers.
 *
 * Recharts is deferred so the first paint doesn't pay for it. The fallback
 * reserves the chart's height, which keeps the surrounding layout from jumping
 * when the chunk arrives.
 */

import { lazy, Suspense } from 'react';
import type { WeekPoint } from './charts';

const WeeklyScoreChart = lazy(() =>
  import('./charts').then((m) => ({ default: m.WeeklyScoreChart })),
);

const WeeklyBarChart = lazy(() =>
  import('./charts').then((m) => ({ default: m.WeeklyBarChart })),
);

function ChartFallback({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-muted)',
        fontSize: 12,
      }}
    >
      Loading chart…
    </div>
  );
}

export function LazyWeeklyScoreChart(props: {
  data: WeekPoint[];
  height?: number;
  showOptimal?: boolean;
}) {
  const height = props.height ?? 240;
  return (
    <Suspense fallback={<ChartFallback height={height} />}>
      <WeeklyScoreChart {...props} />
    </Suspense>
  );
}

export function LazyWeeklyBarChart(props: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  label: string;
  height?: number;
}) {
  const height = props.height ?? 200;
  return (
    <Suspense fallback={<ChartFallback height={height} />}>
      <WeeklyBarChart {...props} />
    </Suspense>
  );
}

export type { WeekPoint };
