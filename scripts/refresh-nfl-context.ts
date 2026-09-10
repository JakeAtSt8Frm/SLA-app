import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv';
import type { InjuryHistory, RosterSnapshot } from '../src/lib/nflContext';
import { parseCurrentInjuries, type CurrentInjurySnapshot } from '../src/lib/currentInjuries';
import { getSchedule } from '../src/lib/sleeper';

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';
const teamAliases: Record<string, string> = { LA: 'LAR', OAK: 'LV', SD: 'LAC' };

async function download(path: string): Promise<{ rows: Array<Record<string, string>>; asOf: string }> {
  const response = await fetch(`${RELEASES}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`nflverse ${path}: HTTP ${response.status}`);
  const modified = response.headers.get('last-modified');
  if (!modified || !Number.isFinite(Date.parse(modified))) throw new Error('Missing source update date');
  return { rows: parseCsv(await response.text()), asOf: new Date(modified).toISOString() };
}

async function save(file: string, value: unknown): Promise<void> {
  const directory = new URL('../public/data/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const destination = new URL(file, directory);
  const temporary = new URL(`${file}.tmp`, directory);
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, destination);
  console.log(`Updated ${fileURLToPath(destination)}`);
}

async function refreshRosters(): Promise<void> {
  const now = new Date();
  const season = String(now.getUTCFullYear() - (now.getUTCMonth() < 2 ? 1 : 0));
  const { rows, asOf } = await download(`rosters/roster_${season}.csv`);
  if (Date.now() - Date.parse(asOf) > 3 * 86_400_000) throw new Error('Roster source is more than 72 hours old');
  const players: RosterSnapshot['players'] = {};
  const teams = new Set<string>();
  for (const row of rows) {
    if (!row.status || row.season !== season) throw new Error('Unexpected roster schema or season');
    if (!/^\d+$/.test(row.sleeper_id)) continue;
    const week = Number(row.week);
    if (!Number.isInteger(week) || week < 0 || week > 22) throw new Error('Invalid roster week');
    const previous = players[row.sleeper_id];
    if (previous && previous.week > week) continue;
    const team = teamAliases[row.team] ?? row.team;
    players[row.sleeper_id] = { team, status: row.status, week };
    teams.add(team);
  }
  if (Object.keys(players).length < 1500 || teams.size < 32) throw new Error('Incomplete NFL roster snapshot');
  await save('nfl-rosters.json', { season, asOf, players } satisfies RosterSnapshot);
  console.log(`${Object.keys(players).length} players; ${Object.values(players).filter((p) => p.status === 'DEV').length} practice squad; source ${asOf}`);
}

async function refreshInjuries(): Promise<void> {
  // nflverse's public injury-report feed ends in 2024. Keep that boundary explicit.
  const seasons = [2023, 2024];
  const history: InjuryHistory = { seasons, players: {} };
  const downloads = await Promise.all(seasons.map((season) => download(`injuries/injuries_${season}.csv`)));
  for (const { rows } of downloads) {
    for (const row of rows) {
      if (row.game_type !== 'REG' || !row.gsis_id) continue;
      const injury = row.report_primary_injury || row.practice_primary_injury;
      if (!injury || /rest|not injury|personal|illness/i.test(injury)) continue;
      const season = Number(row.season);
      const week = Number(row.week);
      if (!seasons.includes(season) || !Number.isInteger(week) || week < 1 || week > 18) throw new Error('Invalid injury report');
      const reports = history.players[row.gsis_id] ??= [];
      if (!reports.some((r) => r.season === season && r.week === week && r.injury === injury)) {
        reports.push({ season, week, injury, status: row.report_status || 'Practice report' });
      }
    }
  }
  if (Object.keys(history.players).length < 500) throw new Error('Incomplete injury history');
  await save('injury-history.json', history);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function refreshCurrentInjuries(): Promise<void> {
  const response = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ESPN injuries: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!record(payload) || !record(payload.season) || typeof payload.timestamp !== 'string' || !Array.isArray(payload.injuries)) throw new Error('ESPN injury schema changed');
  const season = String(payload.season.year);
  const players: CurrentInjurySnapshot['players'] = {};
  for (const team of payload.injuries) {
    if (!record(team) || !Array.isArray(team.injuries)) throw new Error('ESPN team injuries missing');
    for (const row of team.injuries) {
      if (!record(row) || !record(row.athlete) || !Array.isArray(row.athlete.links) || typeof row.status !== 'string' || typeof row.date !== 'string') throw new Error('ESPN player injury changed');
      const link = row.athlete.links.find((link: unknown) => record(link) && typeof link.href === 'string' && /^https:\/\/www\.espn\.com\/nfl\/player\/_\/id\/\d+\//.test(link.href));
      if (!record(link) || typeof link.href !== 'string') continue;
      const id = link.href.match(/\/id\/(\d+)\//)?.[1];
      if (!id) continue;
      if (players[id] && Date.parse(players[id].reportedAt) > Date.parse(row.date)) continue;
      const details = record(row.details) ? row.details : {};
      players[id] = { status: row.status, injury: typeof details.type === 'string' ? details.type : '',
        returnDate: typeof details.returnDate === 'string' ? details.returnDate : null, reportedAt: row.date };
    }
  }
  const games = await getSchedule(season, AbortSignal.timeout(20_000));
  if (games.length < 250) throw new Error('Incomplete regular-season schedule');
  const snapshot = parseCurrentInjuries({ season, asOf: payload.timestamp, players,
    schedule: games.map(({ home, away, date }) => ({ home, away, date: date.slice(0, 10) })) }, season);
  if (!snapshot || Object.keys(players).length < 10) throw new Error('Invalid or stale ESPN injury snapshot');
  await save('current-injuries.json', snapshot);
}

const results = await Promise.allSettled([refreshRosters(), refreshInjuries(), refreshCurrentInjuries()]);
for (const result of results) {
  if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
}
