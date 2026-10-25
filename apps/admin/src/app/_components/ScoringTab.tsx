'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { ConfirmDialog } from './Modal';
import { EASE_OUT, Notice, Skeleton } from './motion';
import { MATCH_TRANSITIONS, canScore, statusLabel, type Fixture } from './types';

interface ScoringTabProps {
  fixtures: Fixture[];
  isLoadingFixtures: boolean;
  selectedFixtureId: string;
  onSelectFixture: (id: string) => void;
  activeFixture: Fixture | null;
  onRefresh: () => void;
  isRecording: boolean;
  handleRecordScoreEvent: (teamId: string, eventType: string, scoreDelta?: number) => void;
  /** Resolves when the API accepts the new match status; rejects with a formal message otherwise. */
  handleChangeMatchStatus: (targetStatus: string) => Promise<void>;
}

const STATUS_ACTION_LABELS: Record<string, string> = {
  SCHEDULED: 'Return to Scheduled',
  CHECK_IN: 'Open Check-In',
  READY: 'Mark as Ready',
  LIVE: 'Start or Resume Match',
  PAUSED: 'Pause Match',
  COMPLETED: 'End Match',
  VERIFIED: 'Verify Result'
};

function teamName(fixture: Fixture, side: 1 | 2): string {
  return side === 1
    ? fixture.team1Name || fixture.team1?.name || 'Team 1'
    : fixture.team2Name || fixture.team2?.name || 'Team 2';
}

/** Score that fades in from above whenever it changes. */
function AnimatedScore({ value, className }: { value: number; className: string }) {
  return (
    <div className={`relative h-14 overflow-hidden ${className}`} aria-live="polite" aria-atomic="true">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } }}
          exit={{ opacity: 0, y: 12, transition: { duration: 0.2 } }}
          className="block text-5xl font-mono font-black leading-[3.5rem]"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export default function ScoringTab({
  fixtures,
  isLoadingFixtures,
  selectedFixtureId,
  onSelectFixture,
  activeFixture,
  onRefresh,
  isRecording,
  handleRecordScoreEvent,
  handleChangeMatchStatus
}: ScoringTabProps) {
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const scoringOpen = canScore(activeFixture?.status);
  const transitions = activeFixture?.status ? MATCH_TRANSITIONS[activeFixture.status] ?? [] : [];

  const confirmStatus = async () => {
    if (!pendingStatus) return;
    setIsChangingStatus(true);
    setStatusError(null);
    try {
      await handleChangeMatchStatus(pendingStatus);
      setPendingStatus(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'The match status could not be changed.');
      setPendingStatus(null);
    } finally {
      setIsChangingStatus(false);
    }
  };

  const goalButton = (side: 1 | 2) => {
    if (!activeFixture) return null;
    const id = side === 1 ? activeFixture.team1Id || activeFixture.team1?.id || '' : activeFixture.team2Id || activeFixture.team2?.id || '';
    return (
      <button
        type="button"
        disabled={!scoringOpen || isRecording || !id}
        onClick={() => handleRecordScoreEvent(id, 'GOAL', 1)}
        aria-label={`Record a goal for ${teamName(activeFixture, side)}`}
        className={`px-4 py-1.5 rounded-lg font-black text-xs text-slate-950 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          side === 1 ? 'bg-[#22C55E] hover:bg-[#16A34A]' : 'bg-amber-500 hover:bg-amber-400'
        }`}
      >
        Record Goal
      </button>
    );
  };

  return (
    <div className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-black text-white tracking-tight">Match Scoring</h2>
          <p className="text-xs text-slate-400">
            Select a match to record goals confirmed by the referees. Goals can be recorded only while a match is live or paused.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="fixture-select" className="sr-only">
            Match
          </label>
          <select
            id="fixture-select"
            value={selectedFixtureId}
            onChange={(e) => onSelectFixture(e.target.value)}
            disabled={fixtures.length === 0}
            className="bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white max-w-[18rem]"
          >
            {fixtures.length === 0 && <option value="">No matches scheduled</option>}
            {fixtures.map((f) => (
              <option key={f.id} value={f.id}>
                Match {f.matchNumber}: {teamName(f, 1)} v {teamName(f, 2)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoadingFixtures}
            aria-label="Refresh matches"
            className="p-2 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-xl text-slate-300 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFixtures ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      <Notice tone="error" message={statusError} onDismiss={() => setStatusError(null)} />

      {isLoadingFixtures && fixtures.length === 0 ? (
        <div className="bg-[#0B0F19] rounded-2xl p-8 border border-slate-800 flex justify-around" aria-hidden="true">
          <Skeleton className="h-24 w-32" />
          <Skeleton className="h-24 w-24" />
          <Skeleton className="h-24 w-32" />
        </div>
      ) : activeFixture ? (
        <div className="space-y-4">
          <div className="bg-[#0B0F19] rounded-2xl p-8 grid grid-cols-1 sm:grid-cols-3 items-center gap-6 border border-slate-800">
            <div className="text-center space-y-2 flex flex-col items-center">
              <div className="text-xs font-mono font-bold text-slate-400">{teamName(activeFixture, 1)} (Blue)</div>
              <AnimatedScore value={activeFixture.team1Score ?? 0} className="text-[#22C55E]" />
              {goalButton(1)}
            </div>

            <div className="text-center font-mono space-y-1">
              <span
                className={`inline-block text-[10px] font-bold px-2.5 py-1 rounded-full border ${
                  scoringOpen ? 'text-[#22C55E] border-[#22C55E]/40 bg-[#22C55E]/10' : 'text-slate-300 border-slate-700 bg-slate-800'
                }`}
              >
                {statusLabel(activeFixture.status)}
              </span>
              <div className="text-sm font-black text-white">Match {activeFixture.matchNumber}</div>
              {(activeFixture.stage || activeFixture.arenaName) && (
                <div className="text-[10px] text-slate-400">
                  {[activeFixture.stage && statusLabel(activeFixture.stage), activeFixture.arenaName].filter(Boolean).join(', ')}
                </div>
              )}
            </div>

            <div className="text-center space-y-2 flex flex-col items-center">
              <div className="text-xs font-mono font-bold text-slate-400">{teamName(activeFixture, 2)} (Red)</div>
              <AnimatedScore value={activeFixture.team2Score ?? 0} className="text-amber-400" />
              {goalButton(2)}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400 font-bold">Match status:</span>
            {transitions.length === 0 && <span className="text-slate-400">The result has been verified; no further changes are possible.</span>}
            {transitions.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setPendingStatus(status)}
                className="px-3 py-1.5 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-200 transition-colors"
              >
                {STATUS_ACTION_LABELS[status] ?? statusLabel(status)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
          No matches have been scheduled.
        </div>
      )}

      <ConfirmDialog
        open={pendingStatus !== null}
        title="Change Match Status"
        message={
          activeFixture && pendingStatus
            ? `Change Match ${activeFixture.matchNumber} from ${statusLabel(activeFixture.status)} to ${statusLabel(pendingStatus)}? The change is visible on the public site immediately.`
            : ''
        }
        confirmLabel="Change Status"
        tone={pendingStatus === 'COMPLETED' || pendingStatus === 'VERIFIED' ? 'danger' : 'primary'}
        busy={isChangingStatus}
        onConfirm={confirmStatus}
        onCancel={() => setPendingStatus(null)}
      />
    </div>
  );
}
