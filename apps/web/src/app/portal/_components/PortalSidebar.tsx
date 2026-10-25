'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, Check, ChevronDown, Loader2, LogOut, X } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { CLOSED_STATUSES, statusLabel, type PortalTab, type TeamInfo } from './types';
import { buildTeamJourney } from './team-journey';
import { DURATION, EASE_OUT, StatusDot } from './motion';

/**
 * Team portal navigation in the "bold bento" style of the public home page, on the portal's dark sidebar:
 * a team header (name, code, registration status), the team's journey from creation to match day (each step
 * opens the section that deals with it) and grouped sections with a lime active pill that glides between
 * items. Rendered in the desktop sidebar and in the mobile drawer.
 */

export interface PortalNavItem {
  id: PortalTab;
  label: string;
  group: 'team' | 'registration' | 'support';
  icon: React.ComponentType<{ className?: string }>;
}

const GROUPS: { id: PortalNavItem['group']; label: string }[] = [
  { id: 'team', label: 'Team' },
  { id: 'registration', label: 'Registration' },
  { id: 'support', label: 'Support' }
];

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bento-lime';

const APPROVED_STATUSES = new Set(['APPROVED', 'ACCREDITED', 'COMPETING', 'ARENA_CLEARED', 'COMPLETED']);

function statusPillClass(status: string): string {
  if (CLOSED_STATUSES.has(status)) return 'bg-rose-600 text-white border-bento-ink';
  if (APPROVED_STATUSES.has(status)) return 'bg-bento-lime text-bento-ink border-bento-ink';
  if (status === 'REQUIRES_ACTION' || status === 'PAYMENT_PENDING') return 'bg-amber-400 text-bento-ink border-bento-ink';
  if (!status || status === 'NOT_SUBMITTED') return 'bg-amber-50 text-amber-800 border-amber-500';
  return 'bg-white text-bento-ink border-bento-ink';
}

interface PortalSidebarProps {
  variant: 'desktop' | 'drawer';
  items: PortalNavItem[];
  activeTab: PortalTab;
  onNavigate: (tab: PortalTab) => void;
  teamInfo: TeamInfo;
  emailVerified: boolean | null;
  memberCount: number;
  isPaid: boolean;
  onSignOut: () => void;
  isSigningOut: boolean;
  onClose?: () => void;
}

export default function PortalSidebar({
  variant,
  items,
  activeTab,
  onNavigate,
  teamInfo,
  emailVerified,
  memberCount,
  isPaid,
  onSignOut,
  isSigningOut,
  onClose
}: PortalSidebarProps) {
  const reduce = useReducedMotion();
  const [journeyOpen, setJourneyOpen] = useState(true);
  // teamId is the registration id: set once a registration has been submitted
  const submitted = Boolean(teamInfo.teamId);
  const journey = buildTeamJourney({
    teamSaved: Boolean(teamInfo.teamRecordId),
    emailVerified,
    memberCount,
    submitted,
    status: teamInfo.status,
    isPaid
  });
  const doneCount = journey.filter((s) => s.state === 'done').length;
  const journeyId = `portal-journey-${variant}`;

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-5">
        <Link href="/" aria-label="GCDIS home" className={`group flex items-center rounded-lg ${FOCUS_RING}`}>
          <span className="transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100">
            <Logo size={40} withWordmark />
          </span>
        </Link>
        {variant === 'drawer' && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className={`flex h-11 w-11 items-center justify-center rounded-xl border-2 border-white/20 text-slate-300 transition-colors hover:border-bento-lime hover:text-bento-lime ${FOCUS_RING}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-5 px-4 py-5">
        {/* Team header */}
        <section aria-label="Your team" className="relative">
          <span aria-hidden="true" className="absolute inset-0 translate-x-[4px] translate-y-[4px] rounded-2xl bg-bento-lime" />
          <div className="relative rounded-2xl border-2 border-bento-ink bg-white p-3.5 text-bento-ink">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-slate-600">Team</p>
            <p className="mt-0.5 break-words text-base font-extrabold uppercase leading-tight tracking-[-0.02em]">
              {teamInfo.name || 'Team not yet saved'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {teamInfo.teamCode && (
                <span className="rounded-md bg-bento-ink px-1.5 py-0.5 font-mono text-[10px] font-bold text-bento-lime">
                  <span className="sr-only">Team code </span>
                  {teamInfo.teamCode}
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full border-2 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${statusPillClass(teamInfo.status)}`}
              >
                <span className="sr-only">Registration status: </span>
                {statusLabel(teamInfo.status)}
              </span>
            </div>
          </div>
        </section>

        {/* Journey */}
        <section aria-labelledby={`${journeyId}-heading`}>
          <h2 id={`${journeyId}-heading`}>
            <button
              type="button"
              onClick={() => setJourneyOpen((v) => !v)}
              aria-expanded={journeyOpen}
              aria-controls={journeyId}
              className={`flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left ${FOCUS_RING}`}
            >
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-slate-300">Your journey</span>
              <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-bento-lime">
                {doneCount}/{journey.length}
              </span>
              <ChevronDown
                className={`h-4 w-4 text-slate-400 transition-transform duration-200 motion-reduce:transition-none ${journeyOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
          </h2>
          <AnimatePresence initial={false}>
            {journeyOpen && (
              <motion.ol
                id={journeyId}
                key="journey"
                initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: DURATION.base, ease: EASE_OUT }}
                className="mt-1 overflow-hidden"
              >
                {journey.map((step, i) => {
                  const last = i === journey.length - 1;
                  const isCurrent = step.state === 'current';
                  const done = step.state === 'done';
                  return (
                    <li key={step.id} className="relative">
                      {!last && (
                        <span
                          aria-hidden="true"
                          className={`absolute left-[15px] top-[26px] h-[calc(100%-18px)] w-0.5 ${done ? 'bg-bento-lime' : 'bg-white/15'}`}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => onNavigate(step.tab)}
                        aria-current={isCurrent ? 'step' : undefined}
                        title={step.detail}
                        className={`group relative flex min-h-[40px] w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-white/[0.06] ${FOCUS_RING}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`relative z-10 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 ml-[4px] ${
                            done
                              ? 'border-bento-lime bg-bento-lime text-bento-ink'
                              : isCurrent
                                ? 'border-bento-lime bg-[#111625] text-bento-lime'
                                : 'border-white/25 bg-[#111625] text-slate-500'
                          }`}
                        >
                          {done ? (
                            <Check className="h-3 w-3" strokeWidth={3.5} />
                          ) : isCurrent ? (
                            <motion.span
                              className="h-2 w-2 rounded-full bg-bento-lime"
                              animate={reduce ? undefined : { scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }}
                              transition={reduce ? undefined : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                            />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-white/30" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-[11px] font-bold uppercase tracking-wide ${
                              done ? 'text-slate-300' : isCurrent ? 'text-white' : 'text-slate-400'
                            }`}
                          >
                            {step.label}
                          </span>
                          {isCurrent && <span className="block text-[10px] leading-snug text-slate-300">{step.detail}</span>}
                          <span className="sr-only">
                            {done ? ' (completed)' : isCurrent ? ' (current step)' : ' (not yet reached)'}. {isCurrent ? '' : step.detail}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </motion.ol>
            )}
          </AnimatePresence>
        </section>

        {/* Grouped sections */}
        <nav aria-label="Team dashboard sections" className="space-y-4">
          <LayoutGroup id={`portal-nav-${variant}`}>
            {GROUPS.map((group) => {
              const groupItems = items.filter((item) => item.group === group.id);
              if (groupItems.length === 0) return null;
              const headingId = `portal-nav-${variant}-${group.id}`;
              return (
                <div key={group.id} role="group" aria-labelledby={headingId}>
                  <h2 id={headingId} className="mb-1.5 flex items-center gap-2 px-2 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bento-lime" />
                    {group.label}
                  </h2>
                  <ul className="space-y-1">
                    {groupItems.map(({ id, label, icon: Icon }) => {
                      const active = activeTab === id;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            onClick={() => onNavigate(id)}
                            aria-current={active ? 'page' : undefined}
                            className={`group relative flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wider transition-colors duration-200 ${FOCUS_RING} ${
                              active ? 'text-bento-ink' : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
                            }`}
                          >
                            {active && (
                              <motion.span
                                layoutId="portal-nav-active"
                                className="absolute inset-0 rounded-xl border-2 border-bento-ink bg-bento-lime shadow-[3px_3px_0_#000]"
                                transition={{ duration: DURATION.base, ease: EASE_OUT }}
                                aria-hidden="true"
                              />
                            )}
                            <Icon
                              className={`relative h-4 w-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${
                                active ? '' : 'group-hover:scale-110 motion-reduce:group-hover:scale-100'
                              }`}
                            />
                            <span className="relative min-w-0 flex-1 truncate">{label}</span>
                            {id === 'doubt' && (
                              <span className="relative flex">
                                <StatusDot className={active ? 'bg-bento-ink' : 'bg-bento-lime'} />
                                <span className="sr-only">(announcement)</span>
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </LayoutGroup>
        </nav>
      </div>

      {/* Return to website and sign out */}
      <div className="space-y-1 border-t border-white/10 p-4">
        <Link
          href="/"
          className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-xs font-bold uppercase tracking-wider text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white ${FOCUS_RING}`}
        >
          <ArrowLeft className="h-4 w-4 text-bento-lime" aria-hidden="true" />
          <span>Return to Website</span>
        </Link>
        <button
          type="button"
          onClick={onSignOut}
          disabled={isSigningOut}
          className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-xs font-bold uppercase tracking-wider text-rose-300 transition-colors hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 ${FOCUS_RING}`}
        >
          {isSigningOut ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{isSigningOut ? 'Signing out…' : 'Sign Out'}</span>
        </button>
      </div>
    </div>
  );
}
