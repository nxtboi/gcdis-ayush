/**
 * Normalisation of public fixture payloads for the championship page, scoreboard and overlay.
 *
 * `GET /competition/fixtures` returns flat rows (`team1Name`, `team1Score`, `arenaName`, ...), while
 * `match_updated` socket events and older payloads nest team data (`team1: { name, institutionName }`).
 * Every public view reads fixtures through `normalizeFixture` so that either shape renders safely.
 *
 * This module is dependency-free so that it can be unit-tested directly.
 */

export interface PublicFixture {
  id: string;
  matchNumber: number | null;
  stage: string | null;
  status: string;
  arenaName: string | null;
  categoryName: string | null;
  currentSet: number | null;
  scheduledStart: string | null;
  team1: { name: string; institution: string | null; score: number };
  team2: { name: string; institution: string | null; score: number };
}

type Raw = Record<string, unknown> | null | undefined;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function side(raw: Record<string, unknown>, n: 1 | 2): PublicFixture['team1'] {
  const nested = obj(raw[`team${n}`]);
  return {
    name: str(raw[`team${n}Name`]) ?? str(nested?.name) ?? `Team ${n}`,
    institution: str(nested?.institutionName) ?? str(raw[`team${n}Institution`]),
    score: num(raw[`team${n}Score`]) ?? num(nested?.score) ?? 0
  };
}

/** Convert any supported fixture payload into a `PublicFixture`. Returns null when the payload has no id. */
export function normalizeFixture(input: Raw): PublicFixture | null {
  const raw = obj(input);
  if (!raw) return null;
  const id = str(raw.id) ?? str(raw.fixtureId);
  if (!id) return null;
  const arena = obj(raw.arena);
  const category = obj(raw.category);
  return {
    id,
    matchNumber: num(raw.matchNumber),
    stage: str(raw.stage),
    status: (str(raw.status) ?? 'SCHEDULED').toUpperCase(),
    arenaName: str(raw.arenaName) ?? str(arena?.name),
    categoryName: str(raw.categoryName) ?? str(category?.name),
    currentSet: num(raw.currentSet),
    scheduledStart: str(raw.scheduledStart),
    team1: side(raw, 1),
    team2: side(raw, 2)
  };
}

/** Normalise a list, dropping entries without an id, ordered by match number then scheduled start. */
export function normalizeFixtures(input: unknown): PublicFixture[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((f) => normalizeFixture(f as Raw))
    .filter((f): f is PublicFixture => f !== null)
    .sort((a, b) => {
      const byNumber = (a.matchNumber ?? Number.MAX_SAFE_INTEGER) - (b.matchNumber ?? Number.MAX_SAFE_INTEGER);
      if (byNumber !== 0) return byNumber;
      return (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? '');
    });
}

/**
 * Merge a partial live update (for example a `summary_score_update`, which carries only scores and
 * status) into the raw fixture list. Returns `null` when the fixture is not in the list, so that the
 * caller can reload the list.
 */
export function mergeFixtureUpdate<T extends Record<string, unknown>>(list: T[], update: Record<string, unknown>): T[] | null {
  const id = str(update.id) ?? str(update.fixtureId);
  if (!id) return list;
  const index = list.findIndex((f) => f.id === id);
  if (index === -1) return null;
  const defined = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined));
  const next = list.slice();
  next[index] = { ...list[index], ...defined, id } as T;
  return next;
}

const STAGE_LABELS: Record<string, string> = {
  QUALIFIER: 'Qualifier',
  GROUP_STAGE: 'Group Stage',
  QUARTER_FINAL: 'Quarter-final',
  SEMI_FINAL: 'Semi-final',
  FINAL: 'Final'
};

const STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CHECK_IN: 'Check-in',
  READY: 'Ready',
  LIVE: 'In Progress',
  IN_PROGRESS: 'In Progress',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  VERIFIED: 'Result Confirmed'
};

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatStage(stage: string | null | undefined): string {
  if (!stage) return 'Match';
  return STAGE_LABELS[stage.toUpperCase()] ?? titleCase(stage);
}

export function formatStatus(status: string | null | undefined): string {
  if (!status) return 'Scheduled';
  return STATUS_LABELS[status.toUpperCase()] ?? titleCase(status);
}

/** A match is "in progress" while it is live or paused between sets. */
export function isInProgress(status: string | null | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return s === 'LIVE' || s === 'IN_PROGRESS' || s === 'PAUSED';
}

/** The fixture to feature on the live-score panel: the first match in progress, if any. */
export function pickLiveFixture(fixtures: PublicFixture[]): PublicFixture | null {
  return fixtures.find((f) => f.status === 'LIVE' || f.status === 'IN_PROGRESS') ?? fixtures.find((f) => isInProgress(f.status)) ?? null;
}

/** Format an ISO timestamp for display in Indian Standard Time, e.g. "12 Nov 2026, 10:30". */
export function formatMatchTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata'
  }).format(date);
}
