'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { Radio, ArrowLeft, Trophy } from 'lucide-react';
import { useMatchSocket, type LiveFixtureUpdate } from '@/lib/useMatchSocket';
import { fetchApi } from '@/lib/api-client';
import { Logo } from '@/components/brand/Logo';
import { AnimatedScore } from '@/components/motion/AnimatedScore';
import { DURATION, EASE_FORMAL } from '@/components/motion/tokens';
import { formatStage, formatStatus, isInProgress, normalizeFixture, normalizeFixtures, pickLiveFixture, type PublicFixture } from '@/lib/fixtures';
import { CHAMPIONSHIP_NAME, CHAMPIONSHIP_PATH, SETS_PER_MATCH } from '@/lib/championship';

type OverlayMode = 'stadium' | 'lowerthird' | 'chroma';

const MODES: { id: OverlayMode; label: string }[] = [
  { id: 'stadium', label: 'Full Screen' },
  { id: 'lowerthird', label: 'Lower Third' },
  { id: 'chroma', label: 'Green Screen' }
];

const GOAL_BANNER_MS = 4500;

/**
 * Broadcast scoreboard for OBS and similar tools. Loads the match currently in progress, then follows
 * live score updates from the scoring gateway. No match clock is shown: the API does not publish one,
 * and a locally simulated clock would not match the official time.
 */
export default function ObsScoreboardOverlayPage() {
  const pathname = usePathname();
  // On /events/<slug>/scoreboard, "Exit" returns to that event; on /live/overlay, to the championship page.
  const exitHref = pathname?.endsWith('/scoreboard') ? pathname.replace(/\/scoreboard$/, '') : CHAMPIONSHIP_PATH;

  const [mode, setMode] = useState<OverlayMode>('stadium');
  const [controlsVisible, setControlsVisible] = useState(true);
  const [recentGoal, setRecentGoal] = useState<string | null>(null);
  const [match, setMatch] = useState<PublicFixture | null>(null);
  const [loaded, setLoaded] = useState(false);

  const matchRef = useRef<PublicFixture | null>(null);
  matchRef.current = match;
  const goalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (goalTimeoutRef.current) clearTimeout(goalTimeoutRef.current);
    },
    []
  );

  // The root layout gives <body> a light background; the lower third must be transparent for compositing.
  useEffect(() => {
    if (mode !== 'lowerthird') return;
    const { body, documentElement } = document;
    const previous = [body.style.background, documentElement.style.background];
    body.style.background = 'transparent';
    documentElement.style.background = 'transparent';
    return () => {
      body.style.background = previous[0];
      documentElement.style.background = previous[1];
    };
  }, [mode]);

  const showGoal = useCallback((teamName: string) => {
    setRecentGoal(teamName);
    if (goalTimeoutRef.current) clearTimeout(goalTimeoutRef.current);
    goalTimeoutRef.current = setTimeout(() => setRecentGoal(null), GOAL_BANNER_MS);
  }, []);

  const loadFixture = useCallback(async (id: string) => {
    try {
      const full = normalizeFixture(await fetchApi<Record<string, unknown>>(`/competition/fixtures/${encodeURIComponent(id)}`));
      if (full) setMatch((current) => (current && current.id !== id && isInProgress(current.status) ? current : full));
    } catch {
      // Keep the current display if the fixture details cannot be loaded.
    }
  }, []);

  // Initial state: the match currently in progress, if any.
  useEffect(() => {
    let cancelled = false;
    fetchApi<unknown>('/competition/fixtures')
      .then((data) => {
        if (!cancelled) setMatch((current) => current ?? pickLiveFixture(normalizeFixtures(data)));
      })
      .catch(() => {
        // The empty state is shown until a live update arrives.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const socketStatus = useMatchSocket((update: LiveFixtureUpdate) => {
    const current = matchRef.current;
    const id = typeof update.id === 'string' ? update.id : null;
    if (!id) return;

    if (current && current.id === id) {
      const next = normalizeFixture({ ...flatten(current), ...stripUndefined(update) });
      if (!next) return;
      if (next.team1.score > current.team1.score) showGoal(next.team1.name);
      else if (next.team2.score > current.team2.score) showGoal(next.team2.name);
      setMatch(next);
      return;
    }

    // An update for another fixture: switch to it only when nothing else is being shown as in progress.
    if (!current || !isInProgress(current.status)) {
      if (isInProgress(typeof update.status === 'string' ? update.status : null) || !current) loadFixture(id);
    }
  });

  const live = match !== null;
  const lowerThird = mode === 'lowerthird';

  return (
    <MotionConfig reducedMotion="user">
      <main
        id="main"
        onDoubleClick={() => setControlsVisible(true)}
        className={`min-h-screen select-none overflow-hidden font-sans transition-colors ${
          mode === 'chroma' ? 'bg-[#00FF00] text-white' : lowerThird ? 'bg-transparent text-white' : 'bg-[#0B0F19] text-white'
        }`}
      >
        <h1 className="sr-only">Live Scoreboard Overlay</h1>

        {/* Operator controls */}
        <AnimatePresence>
          {controlsVisible && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: DURATION.fast, ease: EASE_FORMAL }}
              className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3"
            >
              <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-2xl border border-slate-700/80 bg-[#111625]/90 px-4 py-2 text-xs font-bold text-white shadow-2xl backdrop-blur-md sm:rounded-full">
              <Link href={exitHref} className="flex items-center gap-1.5 uppercase text-slate-300 transition-colors hover:text-white">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Exit Overlay</span>
              </Link>

              <div role="group" aria-label="Display mode" className="flex items-center gap-1 rounded-full border border-slate-800 bg-slate-900 p-1 text-[11px] uppercase">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={mode === m.id}
                    onClick={() => setMode(m.id)}
                    className={`relative rounded-full px-3 py-1 transition-colors ${mode === m.id ? 'font-black text-slate-950' : 'text-slate-400 hover:text-white'}`}
                  >
                    {mode === m.id && (
                      <motion.span
                        layoutId="overlay-mode-pill"
                        className="absolute inset-0 rounded-full bg-[#22C55E]"
                        transition={{ duration: DURATION.fast, ease: EASE_FORMAL }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="relative">{m.label}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setControlsVisible(false)}
                className="text-[11px] text-slate-400 hover:text-white"
                title="Double-click anywhere, or reload the page, to show the controls again"
              >
                Hide Controls
              </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Broadcast logo (omitted in the lower third, which is composited over other video) */}
        {!lowerThird && (
          <div className="pointer-events-none fixed left-4 top-28 z-30 hero-rise md:left-6 md:top-6" style={{ animationDelay: '0.2s' }}>
            <Logo size={72} priority />
          </div>
        )}

        {/* Goal announcement */}
        <AnimatePresence>
          {recentGoal && (
            <motion.div
              key={recentGoal}
              role="status"
              initial={{ opacity: 0, y: -24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: DURATION.base, ease: EASE_FORMAL }}
              className={`pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 ${lowerThird ? 'bottom-36' : 'top-24'}`}
            >
              <div className="flex w-full max-w-xl items-center gap-4 rounded-2xl border-2 border-white bg-[#15803D] px-6 py-4 text-white shadow-2xl">
                <Trophy className="h-8 w-8 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-mono text-[11px] font-black uppercase tracking-widest text-green-100">Goal Confirmed</p>
                  <p className="truncate text-2xl font-black uppercase tracking-tight sm:text-3xl">{recentGoal}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          {!live ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.base, ease: EASE_FORMAL }}
              className={`flex min-h-screen flex-col items-center justify-center p-8 text-center ${lowerThird ? 'justify-end pb-10' : ''}`}
            >
              <div className={`${lowerThird ? 'rounded-2xl bg-[#111625]/90 px-6 py-4' : ''}`}>
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[#22C55E]/30 bg-[#22C55E]/10">
                  <Radio className="h-8 w-8 text-[#22C55E]" aria-hidden="true" />
                </div>
                <p className="mb-2 text-2xl font-black uppercase tracking-wider">Live Scoreboard</p>
                <p className="max-w-md font-mono text-sm text-slate-300">
                  {!loaded
                    ? 'Loading the current match…'
                    : socketStatus === 'connected'
                      ? 'No match is in progress. Scores will be displayed here when a match begins.'
                      : 'No match is in progress. Live updates are currently unavailable; reload this page to try again.'}
                </p>
              </div>
            </motion.div>
          ) : lowerThird ? (
            <motion.div
              key={`lt-${match.id}`}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: DURATION.slow, ease: EASE_FORMAL }}
              className="fixed inset-x-0 bottom-8 flex justify-center px-4"
            >
              <div className="flex w-full max-w-4xl items-stretch overflow-hidden rounded-2xl border border-slate-700 bg-[#111625]/95 shadow-2xl">
                <div className="hidden items-center bg-[#15803D] px-4 sm:flex">
                  <Logo size={44} />
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3">
                  <p className="min-w-0 flex-1 truncate text-right text-lg font-black uppercase sm:text-2xl">{match.team1.name}</p>
                  <p className="shrink-0 rounded-lg bg-slate-950 px-3 py-1 font-mono text-2xl font-black sm:text-3xl">
                    <AnimatedScore value={match.team1.score} className="text-[#22C55E]" label={`${match.team1.name} score`} />
                    <span className="px-1.5 text-slate-500" aria-hidden="true">
                      :
                    </span>
                    <AnimatedScore value={match.team2.score} className="text-sky-400" label={`${match.team2.name} score`} />
                  </p>
                  <p className="min-w-0 flex-1 truncate text-lg font-black uppercase sm:text-2xl">{match.team2.name}</p>
                </div>
                <div className="hidden flex-col justify-center border-l border-slate-700 px-4 font-mono text-[10px] font-bold uppercase text-slate-300 md:flex">
                  <span className="text-[#4ADE80]">{formatStatus(match.status)}</span>
                  {match.currentSet !== null && (
                    <span>
                      Set {match.currentSet} of {SETS_PER_MATCH}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={`full-${match.id}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: DURATION.slow, ease: EASE_FORMAL }}
              className="flex min-h-screen flex-col items-center justify-center px-4 pb-10 pt-40 sm:p-12"
            >
              <div className="mb-8 text-center">
                <p className="mb-1 flex items-center justify-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-[#22C55E]">
                  {isInProgress(match.status) && <span className="radar-live-badge h-2 w-2 rounded-full bg-[#22C55E]" aria-hidden="true" />}
                  {match.arenaName || CHAMPIONSHIP_NAME}
                </p>
                <p className="text-2xl font-black uppercase tracking-tight sm:text-4xl">
                  {formatStage(match.stage)}
                  {match.matchNumber !== null ? ` · Match ${match.matchNumber}` : ''}
                </p>
              </div>

              <div className="w-full max-w-5xl rounded-3xl border-2 border-slate-700/80 bg-[#111625]/90 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
                <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-3 md:gap-8">
                  <div className="text-center md:text-left">
                    <p className="mb-1 font-mono text-xs font-bold uppercase tracking-widest text-slate-400">{match.team1.institution || 'Team 1'}</p>
                    <p className="text-3xl font-black uppercase tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{match.team1.name}</p>
                  </div>

                  <div className="flex flex-col items-center justify-center text-center">
                    <p className="flex items-center gap-4 font-mono font-black sm:gap-6">
                      <AnimatedScore value={match.team1.score} className="text-6xl text-[#22C55E] sm:text-8xl" label={`${match.team1.name} score`} />
                      <span className="text-3xl text-slate-600 sm:text-4xl" aria-hidden="true">
                        :
                      </span>
                      <AnimatedScore value={match.team2.score} className="text-6xl text-sky-400 sm:text-8xl" label={`${match.team2.name} score`} />
                    </p>
                    <p className="mt-4 whitespace-nowrap rounded-full border border-slate-800 bg-slate-900 px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider sm:text-sm">
                      {formatStatus(match.status)}
                      {match.currentSet !== null ? ` · Set ${match.currentSet} of ${SETS_PER_MATCH}` : ''}
                    </p>
                  </div>

                  <div className="text-center md:text-right">
                    <p className="mb-1 font-mono text-xs font-bold uppercase tracking-widest text-slate-400">{match.team2.institution || 'Team 2'}</p>
                    <p className="text-3xl font-black uppercase tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{match.team2.name}</p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

/** Convert a normalised fixture back to the flat API shape so that partial updates can be merged into it. */
function flatten(f: PublicFixture): Record<string, unknown> {
  return {
    id: f.id,
    matchNumber: f.matchNumber,
    stage: f.stage,
    status: f.status,
    arenaName: f.arenaName,
    categoryName: f.categoryName,
    currentSet: f.currentSet,
    scheduledStart: f.scheduledStart,
    team1Name: f.team1.name,
    team2Name: f.team2.name,
    team1Score: f.team1.score,
    team2Score: f.team2.score,
    team1: { name: f.team1.name, institutionName: f.team1.institution },
    team2: { name: f.team2.name, institutionName: f.team2.institution }
  };
}

function stripUndefined(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined && v !== null));
}
