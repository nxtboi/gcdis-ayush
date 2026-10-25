/**
 * Canonical facts about the Drone Soccer Championship 2026, shared by the home page and the
 * championship page so that figures are stated identically everywhere.
 *
 * Source: Federation of International Dronesoccer Association (FIDA), Dronesoccer Regulations,
 * 5th Revision (1 October 2025), in effect from 1 January 2026.
 */

export const FIDA_NAME = 'Federation of International Dronesoccer Association';
export const FIDA_SHORT = 'FIDA';
export const FIDA_EDITION = '5th Revision (1 October 2025)';

export const FIDA_RULEBOOK_D40_URL = 'https://dronesoccer.org/static/files/Rule-book-1.pdf';
export const FIDA_RULEBOOK_D20_URL = 'https://dronesoccer.org/static/files/Rule-book-2.pdf';

export const CHAMPIONSHIP_SLUG = 'drone-soccer-2026';
export const CHAMPIONSHIP_PATH = `/events/${CHAMPIONSHIP_SLUG}`;
export const CHAMPIONSHIP_NAME = 'Drone Soccer Championship 2026';

/** Total prize pool in rupees. */
export const PRIZE_POOL_INR = 100000;

/** Format a rupee amount with Indian digit grouping, e.g. 100000 -> "₹1,00,000". */
export function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

export interface ClassSpec {
  id: 'd20' | 'd40';
  name: string;
  shortName: string;
  ballDiameter: string;
  maxWeight: string;
  strikers: number;
  strikerSummary: string;
  goalDiameter: string;
  rulebookUrl: string;
  prizes: { place: string; amount: number; award: string }[];
}

export const CLASS_SPECS: Record<'d20' | 'd40', ClassSpec> = {
  d40: {
    id: 'd40',
    name: 'Class 40',
    shortName: 'D40',
    ballDiameter: '40 cm ± 2 cm',
    maxWeight: '1,100 g',
    strikers: 1,
    strikerSummary: 'One designated Striker per team',
    goalDiameter: '60 cm',
    rulebookUrl: FIDA_RULEBOOK_D40_URL,
    prizes: [
      { place: 'First Place', amount: 31000, award: 'Gold Trophy' },
      { place: 'Second Place', amount: 21000, award: 'Silver Trophy' }
    ]
  },
  d20: {
    id: 'd20',
    name: 'Class 20',
    shortName: 'D20',
    ballDiameter: '20 cm ± 1 cm',
    maxWeight: '110 g',
    strikers: 2,
    strikerSummary: 'Two designated Strikers per team',
    goalDiameter: '30 cm',
    rulebookUrl: FIDA_RULEBOOK_D20_URL,
    prizes: [
      { place: 'First Place', amount: 21000, award: 'Gold Trophy' },
      { place: 'Second Place', amount: 11000, award: 'Silver Trophy' }
    ]
  }
};

/** Rules common to both classes. */
export const PLAYERS_PER_TEAM = 5;
export const MAX_ROSTER = 7;
export const MAX_COACHES = 3;
export const SETS_PER_MATCH = 3;
export const MINUTES_PER_SET = 3;
export const CLASS_20_ARENA = '8 m × 4 m × 3 m';

/**
 * Championship dates: two days, 1 and 2 December 2026 (IST). The API event (`GET /events/:slug`) is the
 * source of truth for the start and end instants; these are the fallbacks when it cannot be reached.
 */
export const CHAMPIONSHIP_START_FALLBACK = '2026-12-01T09:00:00+05:30';
export const CHAMPIONSHIP_END_FALLBACK = '2026-12-02T18:00:00+05:30';
export const CHAMPIONSHIP_DATES_LABEL = '1–2 December 2026';

/**
 * Championship programme (1 and 2 December 2026). The activities are those of the former four-day programme,
 * compressed into two days; no times are stated until the organising committee confirms them.
 */
export const CHAMPIONSHIP_DAYS = [
  {
    day: 'Day 1',
    date: '1 December',
    title: 'Technical Inspection and Group Stage',
    detail:
      'Measurement and weighing of drone balls, equipment checks and practice flights, followed by group-stage matches of three sets of three minutes each, played in Arena Alpha and Arena Beta.'
  },
  {
    day: 'Day 2',
    date: '2 December',
    title: 'Knockouts, Finals and Prize Distribution',
    detail: 'Quarter-finals, semi-finals and finals in both categories, followed by the prize distribution ceremony.'
  }
] as const;
