/**
 * Matchups — the selected week's head-to-head board.
 *
 * Two questions, in the order they get asked: *who plays who this week*, and
 * *who is winning it*. The pairing board answers the first from the schedule
 * alone, so it still renders for a week that has not kicked off; the simulation
 * below answers the second, and only appears once there is something to
 * simulate.
 *
 * The week comes from the header selector, so this page follows whatever week
 * the rest of the app is showing.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek } from '../data/selectors';
import { weekIsComplete, weekOdds } from '../data/predictions';
import {
  EmptyState,
  RangeReadout,
  StatTile,
  StatTileRow,
  WinProbBar,
  fmt1,
  fmtPct,
} from '../components/primitives';
import { useTheme } from '../components/ThemeProvider';
import { teamColor } from '../lib/colors';
import type { LeagueData, TeamInfo } from '../data/league';
import type { Matchup } from '../lib/types';

/** One side of a game, with everything the board prints about it. */
interface Side {
  team: TeamInfo;
  color: string;
  /** Record carried into this week — not the season-final one. */
  record: string;
  /** Points scored so far under this league's scoring. */
  actual: number;
  /** Starters' projected total, 0 when the week carries no projections yet. */
  projected: number;
}

interface Game {
  matchupId: number;
  home: Side;
  away: Side;
}

/** Groups a week's matchup records into the head-to-head pairs they describe. */
function pairingsOf(matchups: Matchup[]): Array<[number, [number, number]]> {
  const byId = new Map<number, number[]>();
  for (const matchup of matchups) {
    if (matchup.matchup_id === null || matchup.matchup_id === undefined) continue;
    const bucket = byId.get(matchup.matchup_id);
    if (bucket) bucket.push(matchup.roster_id);
    else byId.set(matchup.matchup_id, [matchup.roster_id]);
  }

  return [...byId.entries()]
    .filter(([, rosterIds]) => rosterIds.length === 2)
    .sort((a, b) => a[0] - b[0])
    .map(([matchupId, rosterIds]) => [matchupId, [rosterIds[0], rosterIds[1]]]);
}

/**
 * Each team's record *entering* the given week.
 *
 * The record on the roster is the season-final one, which beside a Week 1 game
 * reads as though the season had already been played. Replaying the completed
 * weeks before this one is what makes the board a snapshot of that week rather
 * than a mix of two points in time. Playoff results are excluded — a league
 * record means the regular season.
 */
function recordsEntering(data: LeagueData, week: number): Map<number, string> {
  const tally = new Map(
    data.teams.map((team) => [team.rosterId, { wins: 0, losses: 0, ties: 0 }]),
  );
  const last = Math.min(week - 1, data.playoff.regularSeasonWeeks);

  for (let past = 1; past <= last; past++) {
    const matchups = data.weeks.get(past)?.matchups ?? [];
    const scoreOf = new Map(matchups.map((m) => [m.roster_id, m.points]));

    for (const [, [a, b]] of pairingsOf(matchups)) {
      const recordA = tally.get(a);
      const recordB = tally.get(b);
      if (!recordA || !recordB) continue;

      const scoreA = scoreOf.get(a) ?? 0;
      const scoreB = scoreOf.get(b) ?? 0;
      if (scoreA > scoreB) {
        recordA.wins++;
        recordB.losses++;
      } else if (scoreB > scoreA) {
        recordB.wins++;
        recordA.losses++;
      } else {
        recordA.ties++;
        recordB.ties++;
      }
    }
  }

  return new Map(
    [...tally].map(([rosterId, { wins, losses, ties }]) => [
      rosterId,
      ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`,
    ]),
  );
}

export function MatchupsPage() {
  const data = useLeagueData();
  const { week, setSelectedRosterId } = useLeague();
  const { mode } = useTheme();

  /**
   * The week's pairings.
   *
   * Read from the week's matchup records, falling back to the schedule pulled
   * for weeks that haven't been played — that fallback is what lets the board
   * answer "who do I have next week" rather than only replaying finished games.
   */
  const board = useMemo(() => {
    const matchups = data.weeks.get(week)?.matchups ?? data.futureMatchups.get(week) ?? [];
    const records = recordsEntering(data, week);

    const sideOf = (rosterId: number): Side | null => {
      const team = data.teamsById.get(rosterId);
      if (!team) return null;
      const rosterWeek = buildRosterWeek(data, rosterId, week);
      return {
        team,
        color: teamColor(rosterId, mode),
        record: records.get(rosterId) ?? '0-0',
        actual: rosterWeek?.actualTotal ?? 0,
        projected: rosterWeek?.projectedTotal ?? 0,
      };
    };

    const games: Game[] = [];
    const paired = new Set<number>();
    for (const [matchupId, [homeId, awayId]] of pairingsOf(matchups)) {
      const home = sideOf(homeId);
      const away = sideOf(awayId);
      if (!home || !away) continue;
      paired.add(homeId);
      paired.add(awayId);
      games.push({ matchupId, home, away });
    }

    // A team with no opponent — a playoff bye, or a week the schedule leaves
    // it out of. Listing it is the difference between "idle this week" and
    // "this page lost your team".
    const idle = data.teams.filter((team) => !paired.has(team.rosterId));

    return { games, idle };
  }, [data, week, mode]);

  /**
   * Win probability for the selected week.
   *
   * A week still in progress is simulated live — finished players contribute
   * their real score and only the rest is sampled. A finished week is replayed
   * from kickoff instead, because "you won" is not a probability and the only
   * interesting question left is what the odds were before it started.
   */
  const complete = useMemo(() => weekIsComplete(data, week), [data, week]);
  const odds = useMemo(() => {
    const simulation = weekOdds(data, week, complete ? 'pregame' : 'live');
    return simulation ? { simulation, pregame: complete } : null;
  }, [data, week, complete]);

  const played = board.games.some((game) => game.home.actual > 0 || game.away.actual > 0);
  const status = !played ? 'Not started' : complete ? 'Final' : 'In progress';

  if (!board.games.length && !board.idle.length) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Matchups</h1>
        </div>
        <EmptyState
          title={`No schedule for Week ${week}`}
          hint="Pick another week from the selector in the header."
        />
      </>
    );
  }

  const marginOf = (game: Game) => Math.abs(game.home.actual - game.away.actual);
  const sides = board.games.flatMap((game) => [game.home, game.away]);
  const highest = played
    ? sides.reduce<Side | null>(
        (best, side) => (!best || side.actual > best.actual ? side : best),
        null,
      )
    : null;
  const closest = played
    ? board.games.reduce<Game | null>(
        (tightest, game) => (!tightest || marginOf(game) < marginOf(tightest) ? game : tightest),
        null,
      )
    : null;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Week {week} Matchups</h1>
      </div>

      <StatTileRow>
        <StatTile label="Games" value={String(board.games.length)} sub={status} />
        {highest && highest.actual > 0 && (
          <StatTile label={`Top score · ${highest.team.name}`} value={fmt1(highest.actual)} />
        )}
        {closest && (
          <StatTile
            label="Closest game"
            value={fmt1(marginOf(closest))}
            sub={`${closest.home.team.name} vs ${closest.away.team.name}`}
          />
        )}
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="stack">
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Week {week} · who plays who</span>
            <span className="mono">
              {board.games.length} {board.games.length === 1 ? 'game' : 'games'}
            </span>
          </div>

          <div className="card-pad h2h">
            {board.games.map((game) => {
              const gameOdds = odds?.simulation.matchups.find(
                (row) => row.matchupId === game.matchupId,
              );
              // The simulation reports its own home/away order, which need not
              // match the board's — read the probability back by roster id.
              const probOf = (rosterId: number) =>
                !gameOdds
                  ? null
                  : gameOdds.home === rosterId
                    ? gameOdds.homeWinProb
                    : gameOdds.away === rosterId
                      ? gameOdds.awayWinProb
                      : null;

              const margin = game.home.actual - game.away.actual;
              const leader = margin > 0 ? game.home : margin < 0 ? game.away : null;

              return (
                <article key={game.matchupId} className="h2h__game">
                  {[game.home, game.away].map((side) => {
                    const prob = probOf(side.team.rosterId);
                    const winning = leader?.team.rosterId === side.team.rosterId;

                    return (
                      <div key={side.team.rosterId} className="h2h__side">
                        <Link
                          className="team-name h2h__name"
                          to="/teams"
                          style={{ color: side.color }}
                          onClick={() => setSelectedRosterId(side.team.rosterId)}
                        >
                          <span
                            className="team-name__dot"
                            style={{ background: side.color }}
                            aria-hidden="true"
                          />
                          {/* Wrapped so the ellipsis has a block to clip: the
                              bare text node would be an anonymous flex item,
                              which text-overflow does not apply to. */}
                          <span className="h2h__name-text">{side.team.name}</span>
                        </Link>

                        <span
                          className="h2h__record tiny muted mono"
                          title={`Record entering Week ${week}`}
                        >
                          {side.record}
                        </span>

                        <span className={`h2h__score mono${winning ? ' is-leading' : ''}`}>
                          {played ? fmt1(side.actual) : '—'}
                          {winning && (
                            <span className="sr-only"> — leading</span>
                          )}
                        </span>

                        <span className="h2h__proj tiny muted mono">
                          {side.projected > 0 ? `proj ${fmt1(side.projected)}` : ''}
                          {prob !== null && (
                            <>
                              {side.projected > 0 ? ' · ' : ''}
                              {fmtPct(prob)}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}

                  <p className="h2h__note tiny muted">
                    {leader
                      ? `${leader.team.name} by ${fmt1(Math.abs(margin))}${
                          odds?.pregame ? '' : ' so far'
                        }`
                      : played
                        ? 'Tied'
                        : game.home.projected > 0 || game.away.projected > 0
                          ? `Projected ${fmt1(game.home.projected)} – ${fmt1(game.away.projected)}`
                          : 'Not yet projected'}
                  </p>
                </article>
              );
            })}
          </div>

          {board.idle.length > 0 && (
            <p className="card-pad tiny muted" style={{ paddingTop: 0 }}>
              No opponent this week: {board.idle.map((team) => team.name).join(', ')}.
            </p>
          )}
        </section>

        {odds && (
          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>
                Week {week} · {odds.pregame ? 'pregame' : 'live'} win probability
              </span>
              <span className="mono">{odds.simulation.iterations.toLocaleString()} sims</span>
            </div>
            <div className="card-pad matchup-odds">
              {odds.simulation.matchups.map((game) => {
                const home = data.teamsById.get(game.home);
                const away = data.teamsById.get(game.away);
                if (!home || !away) return null;
                const homeColor = teamColor(game.home, mode);
                const awayColor = teamColor(game.away, mode);
                const homeBand = odds.simulation.intervals.get(game.home);
                const awayBand = odds.simulation.intervals.get(game.away);

                return (
                  <div key={game.matchupId} className="matchup-odds__row">
                    <div className="matchup-odds__side">
                      <button
                        className="team-name"
                        style={{ color: homeColor }}
                        onClick={() => setSelectedRosterId(game.home)}
                      >
                        <span
                          className="team-name__dot"
                          style={{ background: homeColor }}
                          aria-hidden="true"
                        />
                        {home.name}
                      </button>
                      <span className="matchup-odds__pct mono" style={{ color: homeColor }}>
                        {fmtPct(game.homeWinProb)}
                      </span>
                      {homeBand && (
                        <RangeReadout
                          median={game.homeMean}
                          low={homeBand[0]}
                          high={homeBand[1]}
                          size={13}
                        />
                      )}
                    </div>

                    <span className="tiny muted">vs</span>

                    <div className="matchup-odds__side matchup-odds__side--away">
                      <button
                        className="team-name"
                        style={{ color: awayColor }}
                        onClick={() => setSelectedRosterId(game.away)}
                      >
                        {away.name}
                        <span
                          className="team-name__dot"
                          style={{ background: awayColor }}
                          aria-hidden="true"
                        />
                      </button>
                      <span className="matchup-odds__pct mono" style={{ color: awayColor }}>
                        {fmtPct(game.awayWinProb)}
                      </span>
                      {awayBand && (
                        <RangeReadout
                          median={game.awayMean}
                          low={awayBand[0]}
                          high={awayBand[1]}
                          size={13}
                        />
                      )}
                    </div>

                    <div className="matchup-odds__bar">
                      <WinProbBar
                        homeProb={game.homeWinProb}
                        awayProb={game.awayWinProb}
                        homeColor={homeColor}
                        awayColor={awayColor}
                        label={`${home.name} ${Math.round(game.homeWinProb * 100)} percent, ${away.name} ${Math.round(game.awayWinProb * 100)} percent`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="card-pad tiny muted" style={{ paddingTop: 0 }}>
              Each score is drawn from its own fitted distribution — the projection
              corrected for the bias that source has historically carried, widened
              by the error it has historically made at that projection level. The
              band beside each total is where 80% of simulated outcomes landed.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
