'use client';

import { useEffect, useRef, useState } from 'react';
import { SOCKET_URL } from './api-client';

/** Fixture update delivered by the scoring gateway (`summary_score_update` partial or `match_updated` full fixture). */
export interface LiveFixtureUpdate {
  /** Fixture id (normalized from the summary payload's `fixtureId`). */
  id?: string;
  winnerId?: string | null;
  matchNumber?: number;
  stage?: string;
  status?: string;
  currentSet?: number;
  arenaName?: string;
  arena?: { name?: string } | null;
  team1Name?: string;
  team2Name?: string;
  team1Score?: number;
  team2Score?: number;
  team1?: { id?: string; name?: string; institutionName?: string } | null;
  team2?: { id?: string; name?: string; institutionName?: string } | null;
  [key: string]: unknown;
}

export type MatchSocketStatus = 'connecting' | 'connected' | 'offline' | 'unconfigured';

/** Minimal public payload emitted by the gateway to the `public_summary` room. */
interface SummaryScoreUpdate {
  fixtureId: string;
  matchNumber?: number;
  status?: string;
  team1Score?: number;
  team2Score?: number;
  winnerId?: string | null;
}

/**
 * Subscribes to live fixture updates from the scoring gateway (apps/api/src/scoring/scoring.gateway.ts).
 * - Always joins the `public_summary` room (`join_summary_channel`) and listens for `summary_score_update`
 *   (minimal payload: scores/status only, keyed by `fixtureId`).
 * - When `fixtureId` is given, also joins `match_<fixtureId>` (`join_match_room`) and listens for
 *   `match_updated` (full fixture object).
 * Rooms are (re-)joined on every connect so reconnects keep receiving updates.
 * The socket.io client is loaded lazily on the client only; the latest `onUpdate` callback is used
 * without re-creating the connection. Summary updates are partial: merge them into existing state.
 */
export function useMatchSocket(
  onUpdate: (fixture: LiveFixtureUpdate) => void,
  options: { reconnectionAttempts?: number; fixtureId?: string } = {}
): MatchSocketStatus {
  const [status, setStatus] = useState<MatchSocketStatus>(SOCKET_URL ? 'connecting' : 'unconfigured');
  const handlerRef = useRef(onUpdate);
  handlerRef.current = onUpdate;
  const reconnectionAttempts = options.reconnectionAttempts ?? 3;
  const fixtureId = options.fixtureId;

  useEffect(() => {
    if (!SOCKET_URL) {
      setStatus('unconfigured');
      return;
    }

    let cancelled = false;
    let socket: { disconnect: () => void } | null = null;

    import('socket.io-client')
      .then(({ io }) => {
        if (cancelled) return;
        const s = io(SOCKET_URL, { reconnectionAttempts, timeout: 5000, autoConnect: true, withCredentials: true });
        socket = s;
        s.on('connect', () => {
          setStatus('connected');
          s.emit('join_summary_channel');
          if (fixtureId) s.emit('join_match_room', { fixtureId });
        });
        s.on('disconnect', () => setStatus('offline'));
        s.on('connect_error', () => setStatus('offline'));
        s.on('summary_score_update', (summary: SummaryScoreUpdate) => {
          if (!summary?.fixtureId) return;
          const { fixtureId: id, ...rest } = summary;
          handlerRef.current({ ...rest, id });
        });
        if (fixtureId) {
          s.on('match_updated', (fixture: LiveFixtureUpdate) => {
            if (fixture) handlerRef.current(fixture);
          });
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });

    return () => {
      cancelled = true;
      if (socket) socket.disconnect();
    };
  }, [reconnectionAttempts, fixtureId]);

  return status;
}
