/**
 * Pure countdown helpers for the home page "next event" banner (shared with tests).
 * Times are absolute instants (ISO strings with an explicit offset), so the result does not depend on the
 * visitor's time zone. The banner only calls these after mount, so server and client markup never differ.
 */

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Milliseconds remaining (always > 0). */
  totalMs: number;
}

export type EventPhase = 'upcoming' | 'live' | 'ended';

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
}

/** Time remaining until `target`, or `null` once the target has been reached (or a date is invalid). */
export function getCountdown(target: string | number | Date, now: string | number | Date): CountdownParts | null {
  const totalMs = toMs(target) - toMs(now);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return null;
  const totalSeconds = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMs
  };
}

/** Whether an event is still to come, in progress, or over. */
export function getEventPhase(startsAt: string | number | Date, endsAt: string | number | Date, now: string | number | Date): EventPhase {
  const t = toMs(now);
  if (t < toMs(startsAt)) return 'upcoming';
  if (t <= toMs(endsAt)) return 'live';
  return 'ended';
}

/** Two-digit display value ("07"); values of 100 or more are shown in full. */
export function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}
