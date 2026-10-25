'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check } from 'lucide-react';
import { CLOSED_STATUSES, statusLabel, type RegistrationDocument, type TeamInfo } from './types';
import { ProgressBar, Stagger, StaggerListItem, StatusDot } from './motion';
import { buildRegistrationSteps } from './registration-steps';

export default function StatusTab({
  teamInfo,
  documents,
  isPaid
}: {
  teamInfo: TeamInfo;
  documents: RegistrationDocument[];
  isPaid: boolean;
}) {
  const submitted = Boolean(teamInfo.teamId);
  const closed = CLOSED_STATUSES.has(teamInfo.status);
  const steps = buildRegistrationSteps({
    submitted,
    status: teamInfo.status,
    isPaid,
    documents,
    category: teamInfo.category
  });
  const doneCount = steps.filter((s) => s.state === 'done').length;
  const progress = (doneCount / steps.length) * 100;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-black text-slate-900 uppercase">Registration Status</h2>
            <p className="text-xs text-slate-500 font-medium">
              Progress of your team&apos;s registration through each stage of review.
            </p>
          </div>
          <span className="self-start sm:self-auto px-3 py-1 bg-slate-100 text-slate-700 border border-slate-200 text-xs font-mono font-bold rounded-full uppercase">
            {submitted ? statusLabel(teamInfo.status) : 'Awaiting submission'}
          </span>
        </div>

        {closed && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-800"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This registration is recorded as &ldquo;
              {statusLabel(teamInfo.status)}&rdquo;. Please contact the GCDIS Secretariat for further information.
            </span>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-bold text-slate-600">
            <span>
              {doneCount} of {steps.length} stages complete
            </span>
            {teamInfo.registrationCode && <span className="font-mono text-slate-500">{teamInfo.registrationCode}</span>}
          </div>
          <ProgressBar value={progress} label="Registration progress" />
        </div>

        {/* Steps Timeline */}
        <Stagger stagger={0.06}>
          <ol className="space-y-3">
            {steps.map((item, idx) => (
              <StaggerListItem
                key={item.title}
                aria-current={item.state === 'current' ? 'step' : undefined}
                className={`flex items-start gap-4 p-3.5 border rounded-xl transition-colors ${
                  item.state === 'current' ? 'bg-white border-[#86EFAC] shadow-sm' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full ${
                    item.state === 'done'
                      ? 'bg-[#DCFCE7] text-[#15803D]'
                      : item.state === 'current'
                        ? 'bg-[#15803D] text-white'
                        : 'bg-slate-200 text-slate-500'
                  } flex items-center justify-center shrink-0 font-bold text-xs font-mono`}
                >
                  {item.state === 'done' ? (
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3, delay: 0.15 + idx * 0.06 }}
                    >
                      <Check className="w-4 h-4" aria-hidden="true" />
                    </motion.span>
                  ) : (
                    String(idx + 1).padStart(2, '0')
                  )}
                </div>
                <div className="space-y-0.5 flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-900 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span>{item.title}</span>
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-mono font-bold ${
                        item.state === 'done' ? 'text-[#15803D]' : item.state === 'current' ? 'text-amber-700' : 'text-slate-400'
                      }`}
                    >
                      {item.state === 'current' && <StatusDot className="bg-amber-500" />}
                      {item.state === 'done' ? 'COMPLETED' : item.state === 'current' ? 'IN PROGRESS' : 'PENDING'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">{item.desc}</div>
                </div>
              </StaggerListItem>
            ))}
          </ol>
        </Stagger>
      </div>
    </div>
  );
}
