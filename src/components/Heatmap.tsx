/**
 * Positional heatmap: teams down the side, position groups across the top.
 *
 * Colour encodes each cell's standing *within its own column*, diverging around
 * the league median — so a cell reads as "strong / typical / weak at this
 * position relative to the rest of the league", which is the actual question.
 * Normalising per column matters because the groups aren't comparable in raw
 * points: in this league a starting LB corps routinely outscores the QB slot.
 *
 * Every cell also prints its number, so the colour reinforces the value rather
 * than being the only way to read it.
 */

import { useMemo, useState } from 'react';
import { useTheme } from './ThemeProvider';
import { divergingPosition, heatmapCell } from '../lib/colors';
import { HEATMAP_GROUPS, type HeatmapRow } from '../data/selectors';
import type { PositionGroup } from '../lib/types';

interface Props {
  title: string;
  subtitle?: string;
  rows: HeatmapRow[];
  /** Highlights this team's row. */
  selectedRosterId?: number | null;
  onSelectTeam?: (rosterId: number) => void;
}

export function Heatmap({ title, subtitle, rows, selectedRosterId, onSelectTeam }: Props) {
  const { mode } = useTheme();
  const [showTable, setShowTable] = useState(false);

  // Per-column value lists drive the diverging normalisation.
  const columns = useMemo(() => {
    const byGroup = new Map<PositionGroup, number[]>();
    for (const g of HEATMAP_GROUPS) {
      byGroup.set(
        g,
        rows.map((r) => r.byGroup[g]),
      );
    }
    return { byGroup, totals: rows.map((r) => r.total) };
  }, [rows]);

  // Groups nobody scored in are hidden — with a 6-team league, an empty column
  // is noise rather than information.
  const activeGroups = useMemo(
    () => HEATMAP_GROUPS.filter((g) => columns.byGroup.get(g)!.some((v) => v !== 0)),
    [columns],
  );

  if (!rows.length) return null;

  return (
    <figure className="card" style={{ margin: 0, overflow: 'hidden' }}>
      <figcaption className="row-between" style={{ padding: '12px 14px 8px' }}>
        <div style={{ minWidth: 0 }}>
          <div className="bold" style={{ fontSize: 14 }}>
            {title}
          </div>
          {subtitle && <div className="tiny muted">{subtitle}</div>}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
        >
          {showTable ? 'Heatmap' : 'Table'}
        </button>
      </figcaption>

      <div className="scroll-x">
        <table className="heatmap" aria-label={title}>
          <thead>
            <tr>
              <th scope="col" className="heatmap__team-head">
                Team
              </th>
              {activeGroups.map((g) => (
                <th key={g} scope="col">
                  {g}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = row.rosterId === selectedRosterId;
              return (
                <tr key={row.rosterId} className={isSelected ? 'is-selected' : undefined}>
                  <th scope="row" className="heatmap__team">
                    <button
                      type="button"
                      onClick={() => onSelectTeam?.(row.rosterId)}
                      className="heatmap__team-btn"
                      title={row.name}
                    >
                      {row.name}
                    </button>
                  </th>

                  {activeGroups.map((g) => {
                    const v = row.byGroup[g];
                    const column = columns.byGroup.get(g)!;
                    const cell = showTable
                      ? null
                      : heatmapCell(divergingPosition(v, column), mode, isSelected);
                    return (
                      <td
                        key={g}
                        className="mono"
                        style={
                          cell
                            ? { background: cell.background, color: cell.ink }
                            : undefined
                        }
                        title={`${row.name} — ${g}: ${v.toFixed(2)}`}
                      >
                        {v.toFixed(1)}
                      </td>
                    );
                  })}

                  {(() => {
                    const cell = showTable
                      ? null
                      : heatmapCell(
                          divergingPosition(row.total, columns.totals),
                          mode,
                          isSelected,
                        );
                    return (
                      <td
                        className="mono bold"
                        style={
                          cell ? { background: cell.background, color: cell.ink } : undefined
                        }
                        title={`${row.name} — total: ${row.total.toFixed(2)}`}
                      >
                        {row.total.toFixed(1)}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showTable && (
        <div className="heatmap__legend">
          <span className="tiny muted">Below league</span>
          <span className="heatmap__ramp" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => {
              const { background } = heatmapCell(i / 8, mode);
              return <i key={i} style={{ background }} />;
            })}
          </span>
          <span className="tiny muted">Above league</span>
        </div>
      )}
    </figure>
  );
}
