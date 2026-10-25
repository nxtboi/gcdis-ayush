'use client';

import React from 'react';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { MotionDiv, Skeleton, LoadingAnnouncement, staggerProps } from './motion';
import { formatInr, isChecklistItemComplete, type Checklist, type PrizePool } from './types';

interface OverviewTabProps {
  checklist: Checklist;
  prizePool: PrizePool | null;
  isLoading: boolean;
}

const CARD = 'bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4';

export default function OverviewTab({ checklist, prizePool, isLoading }: OverviewTabProps) {
  const showSkeleton = isLoading && checklist.items.length === 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <section className={CARD} aria-labelledby="checklist-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="checklist-heading" className="text-base font-black text-white tracking-tight">
            Event Readiness Checklist
          </h2>
          {!showSkeleton && (
            <span
              className={`text-xs font-mono font-bold px-3 py-1 rounded-full border ${
                checklist.canGoLive
                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                  : 'text-amber-400 bg-amber-400/10 border-amber-400/30'
              }`}
            >
              {checklist.canGoLive ? 'Ready for Public Registration' : 'Awaiting Organiser Input'}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Each item is verified against the current records before public registration opens.
        </p>
        {isLoading && <LoadingAnnouncement label="Loading the readiness checklist." />}

        <div className="space-y-3 pt-2">
          {showSkeleton &&
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="bg-[#182035] border border-slate-700/80 rounded-xl p-4 space-y-2" aria-hidden="true">
                <Skeleton className="h-3.5 w-56" />
                <Skeleton className="h-3 w-80 max-w-full" />
              </div>
            ))}
          {!showSkeleton && checklist.items.length === 0 && (
            <p className="text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl p-6 text-center">
              No checklist items are available.
            </p>
          )}
          {checklist.items.map((item, index) => {
            const complete = isChecklistItemComplete(item);
            return (
              <MotionDiv
                key={item.id}
                {...staggerProps(index)}
                className="bg-[#182035] border border-slate-700/80 rounded-xl p-4 flex items-start justify-between gap-4 transition-colors hover:border-slate-600"
              >
                <div className="space-y-1">
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    {complete ? (
                      <CheckCircle className="w-4 h-4 text-[#22C55E] shrink-0" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    )}
                    <span>{item.title}</span>
                  </div>
                  {item.detail && <p className="text-[11px] text-slate-400">{item.detail}</p>}
                </div>

                <span
                  className={`text-[10px] font-mono font-bold px-2.5 py-1 rounded shrink-0 border ${
                    complete
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                      : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                  }`}
                >
                  {complete ? 'Complete' : 'Action Required'}
                </span>
              </MotionDiv>
            );
          })}
        </div>
      </section>

      {/* Prize pool summary */}
      {prizePool && (
        <MotionDiv {...staggerProps(4)} className={CARD}>
          <section aria-labelledby="prize-summary-heading" className="space-y-4">
            <h2 id="prize-summary-heading" className="text-base font-black text-white tracking-tight">
              Prize Pool Allocation ({formatInr(prizePool.poolTotal)} in Total)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-xs">
              <div className="bg-[#182035] p-4 rounded-xl border border-slate-700">
                <span className="text-[10px] text-slate-400 block uppercase tracking-wider">Confirmed Allocation</span>
                <strong className="text-lg text-white">{formatInr(prizePool.confirmedTotal)}</strong>
                <div className="text-[11px] text-slate-400 mt-1">Confirmed by the organising committee</div>
              </div>
              <div className="bg-[#182035] p-4 rounded-xl border border-slate-700">
                <span className="text-[10px] text-slate-400 block uppercase tracking-wider">Prize Entries</span>
                <strong className="text-lg text-white">
                  {prizePool.prizes?.length || 0} {(prizePool.prizes?.length || 0) === 1 ? 'Entry' : 'Entries'}
                </strong>
                <div className="text-[11px] text-slate-400 mt-1">Class 20 (D20) and Class 40 (D40)</div>
              </div>
              <div className={`bg-[#182035] p-4 rounded-xl border ${prizePool.unallocated ? 'border-amber-500/40' : 'border-slate-700'}`}>
                <span className={`text-[10px] font-bold block uppercase tracking-wider ${prizePool.unallocated ? 'text-amber-400' : 'text-slate-400'}`}>
                  Unallocated Balance
                </span>
                <strong className={`text-lg ${prizePool.unallocated ? 'text-amber-400' : 'text-white'}`}>
                  {formatInr(prizePool.unallocated)}
                </strong>
                <div className={`text-[11px] mt-1 ${prizePool.unallocated ? 'text-amber-400/80' : 'text-slate-400'}`}>
                  Status: {prizePool.unallocatedStatus || 'Not reported'}
                </div>
              </div>
            </div>
          </section>
        </MotionDiv>
      )}
    </div>
  );
}
