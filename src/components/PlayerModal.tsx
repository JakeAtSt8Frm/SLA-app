/**
 * Player detail sheet.
 *
 * The centrepiece is the projected-vs-actual chart: two series, both computed
 * with the league's custom scoring, so the gap between them is the honest
 * answer to "is this player beating expectations in *our* format" — which for
 * an IDP-heavy league is a very different question than in a standard one.
 *
 * On mobile this presents as a bottom sheet; on desktop, a centred dialog.
 */

import { useEffect, useMemo, useRef } from 'react';
import { LazyWeeklyScoreChart } from './LazyChart';
import { useLeagueData } from '../data/LeagueProvider';
import { playerHeadshot, teamLogo } from '../lib/sleeper';
import { fmt1, fmtPct, fmtSigned, StatusBadge, ValueChip } from './primitives';
import { enrichPlayer } from '../data/selectors';
import { VALUE_WEIGHTS } from '../lib/value';
import { DYNASTY_WEIGHTS } from '../lib/dynasty';

interface Props {
  pid: string | null;
  week: number;
  onClose: () => void;
}

export function PlayerModal({ pid, week, onClose }: Props) {
  const data = useLeagueData();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the sheet so keyboard users land inside it.
  useEffect(() => {
    if (!pid) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();

    // Prevent the page behind the sheet from scrolling on touch devices.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [pid, onClose]);

  const detail = useMemo(() => {
    if (!pid) return null;

    const player = enrichPlayer(data, pid, week, '', false);
    const value = data.valueIndex.byPlayer.get(pid) ?? null;
    const dynasty = data.dynastyIndex.byPlayer.get(pid) ?? null;
    const weekly = data.valueIndex.weeklyScores.get(pid) ?? [];
    const matchupIndex = data.pregameMatchupIndexes.get(week) ?? data.matchupIndex;
    const matchup = matchupIndex.get(player.group, player.opponent);

    const chart = weekly.map((w) => ({
      week: `W${w.week}`,
      projected: w.projected,
      actual: w.actual,
    }));

    return { player, value, dynasty, weekly, matchup, chart };
  }, [data, pid, week]);

  if (!pid || !detail) return null;

  const { player: p, value, dynasty, weekly, matchup, chart } = detail;

  const played = weekly.length;
  const beats = weekly.filter((w) => w.projected !== null && w.actual > w.projected).length;
  const projectedWeeks = weekly.filter((w) => w.projected !== null).length;

  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${p.name} details`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="sheet__grabber" aria-hidden="true" />

        <header className="sheet__header">
          <img
            src={playerHeadshot(p.pid)}
            alt=""
            className="sheet__avatar"
            onError={(e) => {
              const img = e.currentTarget;
              const fallback = teamLogo(p.team);
              if (fallback && img.src !== fallback) img.src = fallback;
              else img.style.visibility = 'hidden';
            }}
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.25 }}>{p.name}</h2>
            <div className="small muted">
              {p.group} · {p.team || 'Free agent'}
              {p.player.age ? ` · age ${p.player.age}` : ''}
              {p.player.years_exp !== null && p.player.years_exp !== undefined
                ? ` · ${p.player.years_exp}y exp`
                : ''}
            </div>
            <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
              <ValueChip score={p.valueScore} />
              {p.ppgRank && (
                <span className="chip chip-outline">
                  {p.group} #{p.ppgRank.rank} PPG
                </span>
              )}
              {p.totalRank && (
                <span className="chip chip-outline">
                  {p.group} #{p.totalRank.rank} total
                </span>
              )}
              {p.isOut && (
                <span className="chip" style={{ color: 'var(--danger-text)' }}>
                  {p.player.injury_status ?? 'OUT'}
                </span>
              )}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          {/* ---- Weekly projected vs actual ---- */}
          <section>
            <h3 className="section-title">
              Projected Score vs Actual Score, by week
            </h3>

            {chart.length === 0 ? (
              <div className="card card-pad muted small">
                No scoring weeks recorded this season.
              </div>
            ) : (
              <>
                <LazyWeeklyScoreChart data={chart} height={240} />

                <div className="small muted" style={{ marginTop: 4 }}>
                  Beat projection in {beats} of {projectedWeeks} projected weeks
                  {played !== projectedWeeks && ` (${played} played)`}.
                </div>
              </>
            )}
          </section>

          {/* ---- Season profile ---- */}
          {value && (
            <section>
              <h3 className="section-title">Season profile</h3>
              <div className="metric-grid">
                <Metric label="Games" value={String(value.breakdown.games)} />
                <Metric label="Total" value={fmt1(value.breakdown.total)} />
                <Metric label="PPG" value={fmt1(value.breakdown.ppg)} />
                <Metric
                  label="Adjusted PPG"
                  value={fmt1(value.breakdown.scheduleAdjustedPpg)}
                />
                <Metric label="Last 4" value={fmt1(value.breakdown.last4)} />
                <Metric label="Last 8" value={fmt1(value.breakdown.last8)} />
                <Metric label="Weighted form" value={fmt1(value.breakdown.ewma)} />
                {value.breakdown.forecastProjection !== null && (
                  <Metric label="Current projection" value={fmt1(value.breakdown.forecastProjection)} />
                )}
                <Metric label="Floor" value={fmt1(value.breakdown.floor)} sub="25th pct week" />
                <Metric label="Ceiling" value={fmt1(value.breakdown.ceiling)} sub="85th pct week" />
                <Metric
                  label="Consistency"
                  value={fmtPct(value.breakdown.consistency)}
                  sub="inverse volatility"
                />
                <Metric label="Availability" value={fmtPct(value.breakdown.availability)} />
                <Metric label="Boom rate" value={fmtPct(value.breakdown.boomRate)} />
                <Metric label="Bust rate" value={fmtPct(value.breakdown.bustRate)} />
                <Metric
                  label="Avg vs proj"
                  value={
                    value.breakdown.deltaAvg >= 0
                      ? `+${value.breakdown.deltaAvg.toFixed(1)}`
                      : value.breakdown.deltaAvg.toFixed(1)
                  }
                />
                {value.breakdown.usagePerGame !== null && (
                  <Metric
                    label="Usage / game"
                    value={value.breakdown.usagePerGame.toFixed(1)}
                    sub="opportunities"
                  />
                )}
                {value.breakdown.recentOpportunityShare !== null && (
                  <Metric
                    label="Team opportunity share"
                    value={fmtPct(value.breakdown.recentOpportunityShare)}
                  />
                )}
                {value.breakdown.snapPct !== null && (
                  <Metric label="Snap share" value={`${value.breakdown.snapPct.toFixed(0)}%`} />
                )}
                {value.breakdown.recentSnapPct !== null && (
                  <Metric
                    label="Recent snap share"
                    value={`${value.breakdown.recentSnapPct.toFixed(0)}%`}
                  />
                )}
                {value.breakdown.startedPct !== null && (
                  <Metric label="Start rate" value={`${value.breakdown.startedPct.toFixed(0)}%`} />
                )}
              </div>
            </section>
          )}


          {/* ---- Dynasty profile ---- */}
          {dynasty && (
            <section>
              <h3 className="section-title">Dynasty {dynasty.score}</h3>
              <div
                className="row wrap"
                style={{ gap: 6, marginBottom: 8, alignItems: 'center' }}
              >
                <span className="chip chip-outline">{dynasty.breakdown.tier}</span>
                <VerdictChip verdict={dynasty.breakdown.verdict} />
                <span className="chip chip-outline">Market: {dynasty.breakdown.marketTrend}</span>
                <span className="chip chip-outline">Liquidity: {dynasty.breakdown.liquidity}</span>
                <span className="chip chip-outline">Injury: {dynasty.breakdown.injuryRisk}</span>
              </div>
              <div className="metric-grid">
                <Metric
                  label="Contender"
                  value={String(dynasty.breakdown.contenderScore)}
                  sub="win-now lens"
                />
                <Metric
                  label="Rebuilder"
                  value={String(dynasty.breakdown.rebuilderScore)}
                  sub="long-term lens"
                />
                {dynasty.breakdown.vorp !== null && (
                  <Metric
                    label="VORP"
                    value={fmtSigned(dynasty.breakdown.vorp)}
                    sub="pts over replacement"
                  />
                )}
                {dynasty.breakdown.blendedPpg !== null && (
                  <Metric
                    label="Blended PPG"
                    value={fmt1(dynasty.breakdown.blendedPpg)}
                    sub="history + fading season forecast"
                  />
                )}
                {dynasty.breakdown.projectedSeasonPoints !== null && (
                  <Metric
                    label="Blended projection"
                    value={fmt1(dynasty.breakdown.projectedSeasonPoints)}
                    sub={
                      dynasty.breakdown.projectionSources.length > 1
                        ? `${dynasty.breakdown.projectionSources
                            .map((source) => source.name)
                            .join(' + ')} · scale-matched average`
                        : `${dynasty.breakdown.projectionSources[0]?.name ?? 'Season'} stats · custom scoring`
                    }
                  />
                )}
                {dynasty.breakdown.projectionSources.length > 1 &&
                  dynasty.breakdown.projectionSources.map((source) => (
                    <Metric
                      key={source.name}
                      label={`${source.name} projection`}
                      value={fmt1(source.total)}
                      sub={
                        source.updatedAt
                          ? `updated ${source.updatedAt} · custom scoring`
                          : 'custom scoring'
                      }
                    />
                  ))}
                {dynasty.breakdown.projectedPpg !== null && (
                  <Metric
                    label="Projected PPG"
                    value={fmt1(dynasty.breakdown.projectedPpg)}
                    sub={`${fmtPct(dynasty.breakdown.projectionWeight)} of production blend`}
                  />
                )}
                {dynasty.breakdown.currentPpg !== null && (
                  <Metric label="This year PPG" value={fmt1(dynasty.breakdown.currentPpg)} />
                )}
                {dynasty.breakdown.priorPpg !== null && (
                  <Metric
                    label="Prior 2yr PPG"
                    value={fmt1(dynasty.breakdown.priorPpg)}
                  />
                )}
                <Metric
                  label="Replacement PPG"
                  value={fmt1(dynasty.breakdown.replacementPpg)}
                  sub={`${dynasty.group} starter cliff`}
                />
                {dynasty.breakdown.age !== null && (
                  <Metric label="Age" value={String(dynasty.breakdown.age)} />
                )}
                {dynasty.breakdown.marketValue !== null && (
                  <Metric
                    label="Market value"
                    value={String(dynasty.breakdown.marketValue)}
                    sub={
                      dynasty.breakdown.marketOverallRank
                        ? `#${dynasty.breakdown.marketOverallRank} overall`
                        : undefined
                    }
                  />
                )}
                {dynasty.breakdown.marketPositionRank !== null && (
                  <Metric
                    label="Market pos rank"
                    value={`${dynasty.group} #${dynasty.breakdown.marketPositionRank}`}
                  />
                )}
              </div>

              <h3 className="section-title" style={{ marginTop: 14 }}>
                Why Dynasty {dynasty.score}
              </h3>
              <div className="small muted" style={{ marginBottom: 8 }}>
                Multi-year VORP and market are ranked across all positions; role and
                efficiency within {dynasty.group}. Missing market (e.g. IDP) reads neutral.
              </div>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th className="num">Weight</th>
                      <th className="num">Percentile</th>
                      <th className="num">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...dynasty.breakdown.contributions]
                      .sort((a, b) => b.points - a.points)
                      .map((c) => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num muted">
                            {((c.weight / dynastyTotalWeight) * 100).toFixed(0)}%
                          </td>
                          <td className="num">{fmtPct(c.normalized)}</td>
                          <td className="num bold">{(c.points * 1000).toFixed(0)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- This week's matchup ---- */}
          {matchup && (
            <section>
              <h3 className="section-title">
                Matchup vs {matchup.defense}
              </h3>
              <div className="metric-grid">
                <Metric
                  label="Matchup score"
                  value={String(matchup.score)}
                />
                <Metric label="Defence baseline" value={String(matchup.baseScore)} />
                <Metric
                  label="Adjusted-allowed score"
                  value={String(matchup.opponentAdjustedScore)}
                />
                <Metric
                  label="Opportunity score"
                  value={String(matchup.opportunityScore)}
                />
                <Metric
                  label="Allowed / game"
                  value={fmt1(matchup.pointsPerGame)}
                  sub={`to ${matchup.group}s`}
                />
                <Metric
                  label="Adjusted allowed"
                  value={fmt1(matchup.opponentAdjustedPpg)}
                />
                <Metric
                  label="Opportunities allowed"
                  value={fmt1(matchup.opportunitiesPerGame)}
                />
                <Metric label="Last 4" value={fmt1(matchup.last4)} />
                <Metric
                  label="Generosity rank"
                  value={`#${matchup.rankMostGenerous}`}
                  sub="1 = most generous"
                />
                <Metric label="Ceiling rate" value={fmtPct(matchup.ceilingRate)} />
                <Metric label="Floor rate" value={fmtPct(matchup.floorRate)} />
              </div>
            </section>
          )}

          {/* ---- Week-by-week table (the non-visual view of the chart) ---- */}
          {weekly.length > 0 && (
            <section>
              <h3 className="section-title">Week by week</h3>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th>Opponent</th>
                      <th className="num">Projected</th>
                      <th className="num">Actual</th>
                      <th className="num">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekly.map((w) => {
                      const delta = w.projected === null ? null : w.actual - w.projected;
                      return (
                        <tr key={w.week}>
                          <td>Week {w.week}</td>
                          <td className="mono">{w.opponent ?? '—'}</td>
                          <td className="num muted">
                            {w.projected === null ? '—' : w.projected.toFixed(1)}
                          </td>
                          <td className="num bold">{w.actual.toFixed(1)}</td>
                          <td
                            className="num"
                            style={{
                              color:
                                delta === null
                                  ? 'var(--text-muted)'
                                  : delta >= 0
                                    ? 'var(--success-text)'
                                    : 'var(--danger-text)',
                            }}
                          >
                            {delta === null
                              ? '—'
                              : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- Why this Value Score ---- */}
          {value && (
            <section>
              <h3 className="section-title">
                Why Value {value.score}
              </h3>
              <div className="small muted" style={{ marginBottom: 8 }}>
                Each term is a percentile within {value.group}, times its weight.
                {value.breakdown.gamesConfidence < 1 && (
                  <>
                    {' '}
                    Small sample: blended {fmtPct(1 - value.breakdown.gamesConfidence)} toward
                    neutral.
                  </>
                )}
              </div>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th className="num">Weight</th>
                      <th className="num">Percentile</th>
                      <th className="num">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...value.breakdown.contributions]
                      .sort((a, b) => b.points - a.points)
                      .map((c) => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num muted">
                            {((c.weight / totalWeight) * 100).toFixed(1)}%
                          </td>
                          <td className="num">{fmtPct(c.normalized)}</td>
                          <td className="num bold">{(c.points * 1000).toFixed(0)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="row" style={{ gap: 8, paddingBottom: 8 }}>
            <StatusBadge status={p.status} />
            <span className="tiny muted">
              Week {week} classification, using this league's scoring.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const totalWeight = Object.values(VALUE_WEIGHTS).reduce((a, b) => a + b, 0);
const dynastyTotalWeight = Object.values(DYNASTY_WEIGHTS).reduce((a, b) => a + b, 0);

/** Buy/Sell/Fair marker for the gap between intrinsic value and market price. */
function VerdictChip({ verdict }: { verdict: string }) {
  const tone =
    verdict === 'Buy'
      ? 'var(--success-text)'
      : verdict === 'Sell'
        ? 'var(--danger-text)'
        : 'var(--text-muted)';
  const label =
    verdict === 'Buy'
      ? 'Buy low'
      : verdict === 'Sell'
        ? 'Sell high'
        : verdict === 'Fair'
          ? 'Fairly valued'
          : 'No market';
  return (
    <span
      className="chip"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
      title="Intrinsic dynasty value vs current market price"
    >
      {label}
    </span>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="metric">
      <div className="tiny muted">{label}</div>
      <div className="mono bold" style={{ fontSize: 16 }}>
        {value}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}
