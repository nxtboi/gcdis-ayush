'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Users, Rocket, FileText, CheckCircle2, Download, Check, Info, CreditCard, Loader2, AlertTriangle } from 'lucide-react';
import { CLOSED_STATUSES, NOT_AVAILABLE_LABEL, statusLabel, type TeamInfo } from './types';
import TeamSetupPanel, { type TeamSetupData } from './TeamSetupPanel';
import { formatFee, type CategoriesState } from './categories';
import { cardHover, FadeIn, MotionButton, ProgressBar, Stagger, StaggerItem } from './motion';
import VerificationRequiredNotice, { type EmailVerificationGate } from './VerificationRequiredNotice';

export interface PaymentUiState {
  busy: boolean;
  error: string | null;
  message: string | null;
}

interface OverviewTabProps {
  teamInfo: TeamInfo;
  /** True while the team record is being fetched for the first time. */
  loading: boolean;
  memberCount: number;
  documentCount: number;
  profileCompletion: number;
  isPaid: boolean;
  payState: PaymentUiState;
  onPay: () => void;
  onGoToUploads: () => void;
  onGoToMembers: () => void;
  categoriesState: CategoriesState;
  /** Message shown when team setup failed during sign-up (the account itself was created). */
  teamSetupError: string | null;
  /** Saves the team (POST /teams) and submits the registration (POST /registrations). */
  onCompleteSetup: (data: TeamSetupData) => Promise<void>;
  /** Set while the captain email is unverified (registration and payment are blocked until then). */
  verificationGate?: EmailVerificationGate | null;
}

const cardClass =
  'relative h-full overflow-hidden bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col justify-between transition-[box-shadow,border-color] duration-200 hover:shadow-md hover:border-slate-300/80';

/** Placeholder shown while the team record loads (same footprint as the real cards, so nothing shifts). */
function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading your team record" className="space-y-6 max-w-6xl">
      <div className="h-40 rounded-2xl border border-slate-200/80 bg-white p-8 shadow-sm">
        <div className="h-3 w-48 rounded bg-slate-100 motion-safe:animate-pulse" />
        <div className="mt-4 h-8 w-72 max-w-full rounded bg-slate-100 motion-safe:animate-pulse" />
        <div className="mt-4 h-3 w-96 max-w-full rounded bg-slate-100 motion-safe:animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 rounded-2xl border border-slate-200/80 bg-white shadow-sm motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function OverviewTab({
  teamInfo,
  loading,
  memberCount,
  documentCount,
  profileCompletion,
  isPaid,
  payState,
  onPay,
  onGoToUploads,
  onGoToMembers,
  categoriesState,
  teamSetupError,
  onCompleteSetup,
  verificationGate
}: OverviewTabProps) {
  if (loading) return <OverviewSkeleton />;

  const teamSaved = Boolean(teamInfo.teamRecordId);
  const needsSetup = !teamSaved || !teamInfo.teamId;
  const closed = CLOSED_STATUSES.has(teamInfo.status);
  const needsAction = teamInfo.status === 'REQUIRES_ACTION';
  // Entry fee of the team's category, shown beside the Pay button (GST-inclusive, as charged by the order)
  const teamCategory = categoriesState.categories.find((c) => c.id === teamInfo.categoryId);
  const entryFeeLabel = teamCategory && teamCategory.entryFee > 0 ? formatFee(teamCategory.entryFee, teamCategory.currency) : null;

  return (
    <div className="space-y-6 max-w-6xl">
      {teamSetupError && needsSetup && (
        <FadeIn role="alert" className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs font-semibold">
          {teamSetupError}
        </FadeIn>
      )}
      {needsSetup && (
        <TeamSetupPanel
          key={teamInfo.teamRecordId || 'new-team'}
          categoriesState={categoriesState}
          teamSaved={teamSaved}
          initial={{
            teamName: teamInfo.name,
            categoryId: teamInfo.categoryId,
            institute: teamInfo.institute,
            city: teamInfo.city
          }}
          onSubmit={onCompleteSetup}
          verificationGate={verificationGate}
          captain={{ name: teamInfo.captainName, email: teamInfo.captainEmail, mobile: teamInfo.captainMobile }}
          memberCount={memberCount}
          onGoToMembers={onGoToMembers}
        />
      )}

      {(closed || needsAction) && (
        <FadeIn
          role="status"
          className={`flex items-start gap-3 rounded-xl border p-4 text-xs font-semibold ${
            closed ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {closed
              ? `Your registration is recorded as "${statusLabel(teamInfo.status)}". Please contact the GCDIS Secretariat if you believe this is an error.`
              : 'The GCDIS Secretariat has requested further information. Please review your documents and contact the Secretariat if the required action is unclear.'}
          </span>
        </FadeIn>
      )}

      {/* TOP HERO WELCOME CARD */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 shadow-sm"
      >
        <div className="space-y-1.5 max-w-2xl min-w-0">
          <span className="text-[11px] font-mono font-bold text-[#15803D] uppercase tracking-wider block">
            Drone Soccer Championship 2026
          </span>
          <h2 className="text-2xl sm:text-4xl font-black text-slate-950 uppercase tracking-tight break-words">
            {teamInfo.name ? `Team ${teamInfo.name}` : teamInfo.captainName ? `Welcome, ${teamInfo.captainName}` : 'Welcome'}
          </h2>
          <p className="text-xs text-slate-600 font-medium leading-relaxed">
            This dashboard is the official record of your team&apos;s entry. From here you may manage the team roster, review the
            rules of your competition category, submit documents and follow the progress of your registration.
          </p>
          {!teamSaved && (
            <p
              role="status"
              className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"
            >
              Your captain account is active, but no team has yet been registered with it. Please complete the team registration
              form above to submit your entry.
            </p>
          )}
        </div>

        {/* Status Box */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 flex items-center gap-4 shadow-sm shrink-0 w-full md:w-auto md:min-w-[220px]">
          <div className="w-10 h-10 shrink-0 rounded-full bg-[#DCFCE7] border border-[#86EFAC] text-[#15803D] flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-[#15803D] uppercase tracking-wider font-mono flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#15803D]" aria-hidden="true" />
              Registration Status
            </div>
            <div className="text-sm font-black text-slate-900">{statusLabel(teamInfo.status)}</div>
            <div className="text-[10px] text-slate-500 font-medium font-mono break-all">{teamInfo.statusDesc}</div>
          </div>
        </div>
      </motion.div>

      {/* FIVE-CARD GRID WITH WATERMARK NUMBERS (01–05) */}
      <Stagger className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" stagger={0.06} delayChildren={0.08}>
        {/* CARD 01: TEAM PROFILE */}
        <StaggerItem>
          <motion.div whileHover={cardHover} className={cardClass}>
            <div className="watermark-number" aria-hidden="true">
              01
            </div>
            <div className="space-y-4 relative z-10">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">Team Profile</h3>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Team Name</div>
                <div className="text-xl font-black text-slate-950 uppercase break-words">
                  {teamInfo.name || 'Not yet registered'}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Team ID</div>
                <span className="inline-block bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-xs font-mono font-bold px-2.5 py-0.5 rounded-md">
                  {teamInfo.teamCode || 'To be assigned'}
                </span>
              </div>
              <hr className="border-slate-100" />
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Institution</div>
                <div className="text-xs font-bold text-slate-700">{teamInfo.institute || 'Not specified'}</div>
                {teamInfo.city && <div className="text-[11px] text-slate-500">{teamInfo.city}</div>}
              </div>
            </div>
          </motion.div>
        </StaggerItem>

        {/* CARD 02: REGISTERED MEMBERS */}
        <StaggerItem>
          <motion.div whileHover={cardHover} className={cardClass}>
            <div className="watermark-number" aria-hidden="true">
              02
            </div>
            <div className="space-y-3 relative z-10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#DCFCE7] text-[#15803D] flex items-center justify-center">
                  <Users className="w-5 h-5" aria-hidden="true" />
                </div>
                <span className="text-4xl font-black text-[#15803D] font-sans tabular-nums">
                  {memberCount}
                  <span className="text-base font-bold text-slate-400"> / {teamInfo.maxTeamSize}</span>
                </span>
              </div>
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">Registered Members</h3>
                <p className="text-[11px] text-slate-600 font-medium mt-0.5">
                  Including the captain. The roster may contain at most {teamInfo.maxTeamSize} members, of whom no more than three
                  may be coaches.
                </p>
              </div>
              <button
                type="button"
                onClick={onGoToMembers}
                className="self-start text-[11px] font-bold text-[#15803D] underline-offset-2 hover:underline"
              >
                Manage team members
              </button>
            </div>
          </motion.div>
        </StaggerItem>

        {/* CARD 03: REGISTRATION PAYMENT */}
        <StaggerItem>
          <motion.div whileHover={cardHover} className={cardClass}>
            <div className="watermark-number" aria-hidden="true">
              03
            </div>
            <div className="space-y-4 relative z-10">
              <div className="w-9 h-9 rounded-full bg-[#DCFCE7] text-[#15803D] flex items-center justify-center">
                {isPaid ? (
                  <Check className="w-5 h-5" aria-hidden="true" />
                ) : (
                  <CreditCard className="w-4 h-4" aria-hidden="true" />
                )}
              </div>
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">Entry Fee</h3>
                <div className="mt-2">
                  {teamInfo.status === 'PAYMENT_PENDING' && !isPaid ? (
                    <>
                    <MotionButton
                      type="button"
                      onClick={onPay}
                      disabled={payState.busy}
                      className="inline-flex items-center gap-2 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 disabled:cursor-wait text-slate-950 font-black text-xs uppercase rounded-full shadow-sm transition-colors"
                    >
                      {payState.busy && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      )}
                      <span>{payState.busy ? 'Opening payment…' : 'Pay entry fee'}</span>
                    </MotionButton>
                    {entryFeeLabel && (
                      <p className="mt-2 text-[11px] font-semibold text-slate-600" data-testid="entry-fee-amount">
                        {entryFeeLabel} (incl. GST)
                      </p>
                    )}
                    </>
                  ) : isPaid ? (
                    <span className="inline-block bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-xs font-mono font-bold px-3 py-1 rounded-md">
                      PAID
                    </span>
                  ) : (
                    <>
                      <span className="inline-block bg-slate-100 text-slate-600 border border-slate-200 text-xs font-mono font-bold px-3 py-1 rounded-md">
                        NOT YET DUE
                      </span>
                      <p className="mt-2 text-[11px] text-slate-500">
                        The Pay button appears here as soon as your registration has been submitted.
                      </p>
                    </>
                  )}
                  {verificationGate && teamInfo.status === 'PAYMENT_PENDING' && !isPaid && (
                    <div className="mt-2">
                      <VerificationRequiredNotice gate={verificationGate} action="pay the entry fee" />
                    </div>
                  )}
                  {payState.error && !(verificationGate && teamInfo.status === 'PAYMENT_PENDING') && (
                    <FadeIn role="alert" className="mt-2 text-[11px] font-semibold text-rose-600">
                      {payState.error}
                    </FadeIn>
                  )}
                  {payState.message && (
                    <FadeIn role="status" className="mt-2 text-[11px] font-semibold text-[#15803D]">
                      {payState.message}
                    </FadeIn>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </StaggerItem>

        {/* CARD 04: COMPETITION CATEGORY */}
        <StaggerItem>
          <motion.div whileHover={cardHover} className={cardClass}>
            <div className="watermark-number" aria-hidden="true">
              04
            </div>
            <div className="space-y-4 relative z-10">
              <div className="w-9 h-9 rounded-full bg-[#DCFCE7] text-[#15803D] flex items-center justify-center">
                <Rocket className="w-4 h-4" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">Competition Category</h3>
                <div className="mt-2">
                  <span className="inline-block bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-xs font-bold px-3 py-1 rounded-md">
                    {teamInfo.category || 'Not yet selected'}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        </StaggerItem>

        {/* CARD 05: TEAM PROFILE COMPLETION */}
        <StaggerItem className="md:col-span-2">
          <motion.div whileHover={cardHover} className={cardClass}>
            <div className="watermark-number" aria-hidden="true">
              05
            </div>
            <div className="space-y-3 relative z-10">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-1.5">
                <span>Registration Completeness</span>
                <span
                  className="text-slate-400"
                  title="Calculated from: team saved, registration submitted, institution and city recorded, captain mobile number, at least five members on the roster, and at least one document uploaded."
                >
                  <Info className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="sr-only">How this is calculated</span>
                </span>
              </h3>
              <div className="text-3xl font-black text-slate-900 font-mono tabular-nums">{profileCompletion}%</div>
              <ProgressBar value={profileCompletion} label="Registration completeness" />
              <p className="text-[11px] text-slate-500">
                {needsSetup
                  ? teamSaved
                    ? 'Your team is saved. Submit the registration above to continue.'
                    : 'Complete the team registration form above to begin.'
                  : documentCount === 0
                    ? 'Upload your institutional approval letter to progress your registration.'
                    : memberCount < 5
                      ? 'Add at least five members (the FIDA line-up) to complete your roster.'
                      : 'Your registration record is complete. The Secretariat will review it in due course.'}
              </p>
            </div>
          </motion.div>
        </StaggerItem>
      </Stagger>

      {/* BOTTOM CARD: INSTITUTIONAL APPROVAL LETTER */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="bg-white border border-slate-200/80 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 shadow-sm"
      >
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl bg-[#DCFCE7] text-[#15803D] flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-black text-slate-900 uppercase">Institutional Approval Letter</h3>
            <p className="text-xs text-slate-600 font-medium">
              A signed letter from your institution is required to confirm your team&apos;s participation in the Drone Soccer
              Championship 2026.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0 w-full md:w-auto">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="The endorsement letter template is not yet available for download."
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-slate-200 text-slate-400 bg-slate-50 text-xs font-bold uppercase cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Template: {NOT_AVAILABLE_LABEL}</span>
          </button>

          <MotionButton
            type="button"
            onClick={onGoToUploads}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#15803D] hover:bg-[#166534] text-white text-xs font-black uppercase transition-colors shadow-sm"
          >
            <span>Go to Document Uploads</span>
          </MotionButton>
        </div>
      </motion.div>
    </div>
  );
}
