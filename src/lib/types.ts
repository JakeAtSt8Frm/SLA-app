/**
 * Core domain types for the SLA app.
 *
 * Everything here mirrors the shapes returned by the Sleeper API. We keep the
 * raw stat payloads as open records because the league's scoring settings
 * reference 140 different stat keys and Sleeper adds new ones over time.
 */

/** A raw Sleeper stat line: stat key -> value. Keys match scoring_settings keys. */
export type StatLine = Record<string, number | undefined>;

/** League scoring settings: stat key -> points multiplier. */
export type ScoringSettings = Record<string, number>;

export interface League {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: ScoringSettings;
  settings: Record<string, number>;
  previous_league_id?: string | null;
}

export interface SleeperUser {
  user_id: string;
  display_name: string;
  username?: string;
  avatar?: string | null;
  metadata?: { team_name?: string; avatar?: string } | null;
}

export interface RosterSettings {
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  fpts_decimal?: number;
  fpts_against?: number;
  fpts_against_decimal?: number;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  settings: RosterSettings;
  metadata?: Record<string, string> | null;
}

export interface Matchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  players: string[] | null;
  starters: string[] | null;
  players_points?: Record<string, number> | null;
  starters_points?: number[] | null;
}

export interface Player {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  age?: number | null;
  birth_date?: string | null;
  injury_status?: string | null;
  status?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
  years_exp?: number | null;
  number?: number | null;
  active?: boolean;
}

export interface NflState {
  week: number;
  leg: number;
  season: string;
  season_type: string;
  display_week: number;
  previous_season: string;
  league_season: string;
}

/** Sleeper's research endpoint: ownership/start percentages for a week. */
export interface ResearchEntry {
  owned?: number;
  started?: number;
}

/**
 * Position groups used for ranking and comparison. Every NFL position maps to
 * exactly one of these, so a DE and a DT compete in the same "DL" pool.
 */
export type PositionGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DL' | 'LB' | 'DB';

export const POSITION_GROUPS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];

/** Maps every raw Sleeper position onto its scoring-relevant group. */
export const POSITION_TO_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  // Defensive line
  DL: 'DL',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  // Linebackers
  LB: 'LB',
  ILB: 'LB',
  OLB: 'LB',
  MLB: 'LB',
  // Defensive backs
  DB: 'DB',
  CB: 'DB',
  S: 'DB',
  SS: 'DB',
  FS: 'DB',
};

/** Boom/bust classification for a single player-week. */
export type StatusLabel =
  | 'Major Boom'
  | 'Boom'
  | 'In Range'
  | 'Bust'
  | 'Major Bust'
  | 'Not Played'
  | 'No Proj';

export interface PlayerStatus {
  label: StatusLabel;
  /** CSS custom property name carrying this status's colour. */
  tone: string;
}

/** Fully derived per-player-week view model used across every page. */
export interface EnrichedPlayer {
  pid: string;
  player: Player;
  name: string;
  team: string;
  group: PositionGroup | null;
  /** The roster slot this player occupies (QB, FLEX, BN, IR...). */
  slot: string;
  isStarter: boolean;
  /** Custom-scored projection for the week. */
  proj: number;
  /** Custom-scored actual for the week. */
  act: number;
  hasPlayed: boolean;
  status: PlayerStatus;
  opponent: string | null;
  isOut: boolean;
  seasonTotal: number;
  /** Headline Value Score (0–1000): blended in-season form and dynasty value. */
  valueScore: number | null;
  matchupScore: number | null;
  ppgRank: RankInfo | null;
  totalRank: RankInfo | null;
}

export interface RankInfo {
  group: PositionGroup;
  rank: number;
  outOf: number;
  value: number;
}
