'use client';

import React, { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, ClipboardList, Loader2, Lock, Mail, Phone, UserRound, Users } from 'lucide-react';
import type { CategoriesState } from './categories';
import { FadeIn } from './motion';
import VerificationRequiredNotice, { type EmailVerificationGate } from './VerificationRequiredNotice';
import {
  CITY_MAX,
  INSTITUTE_MAX,
  TEAM_NAME_MAX,
  WIZARD_STEPS,
  hasErrors,
  validateCategory,
  validateTeamDetails,
  type FieldErrors
} from './registration-validation';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CategoryCards,
  DraftRestoreBanner,
  ErrorSummary,
  ReviewSection,
  StepPanel,
  WizardField,
  WizardProgress,
  describedBy,
  firstCategoryInputId,
  focusFirstError,
  wizardInput
} from './WizardParts';
import { TEAM_SETUP_DRAFT_KEY, useWizardDraft } from './wizard-draft';

export interface TeamSetupData {
  teamName: string;
  categoryId: string;
  institute: string;
  city: string;
}

interface TeamSetupPanelProps {
  categoriesState: CategoriesState;
  /** Prefill values (e.g. the captain's institution, or a team saved without a registration). */
  initial?: Partial<TeamSetupData>;
  /** True when the team already exists and only the registration still has to be submitted. */
  teamSaved: boolean;
  onSubmit: (data: TeamSetupData) => Promise<void>;
  /** Set while the captain email is unverified: the registration cannot be submitted yet. */
  verificationGate?: EmailVerificationGate | null;
  /** Captain account details (read-only here; shown on the "Captain & members" step). */
  captain?: { name: string; email: string; mobile: string };
  /** Current roster size (the API adds the captain when the team is saved). */
  memberCount?: number;
  /** Opens the Team Members section (available once the team is saved). */
  onGoToMembers?: () => void;
}

type SetupErrors = FieldErrors<keyof TeamSetupData>;

const FIELD_ORDER: { key: keyof TeamSetupData; id: string }[] = [
  { key: 'teamName', id: 'setup-team-name' },
  { key: 'institute', id: 'setup-institute' },
  { key: 'city', id: 'setup-city' }
];

/** Errors of one wizard step (0 = team details, 2 = category); other steps have no fields here. */
function stepErrors(step: number, data: TeamSetupData, teamSaved: boolean): SetupErrors {
  if (teamSaved) return {};
  if (step === 0) return validateTeamDetails(data);
  if (step === 2) return validateCategory(data.categoryId);
  return {};
}

/**
 * "Complete team registration" wizard shown on the dashboard while the captain has no team or registration:
 * Team details → Captain & members → Category → Review & submit. Inline validation mirrors CreateTeamDto;
 * the draft is autosaved in this browser. Submission still calls `onSubmit` (POST /teams, then
 * POST /registrations) exactly as before, and stays blocked until the captain email is verified.
 */
export default function TeamSetupPanel({
  categoriesState,
  initial,
  teamSaved,
  onSubmit,
  verificationGate,
  captain,
  memberCount = 0,
  onGoToMembers
}: TeamSetupPanelProps) {
  const blocked = Boolean(verificationGate);
  const [data, setData] = useState<TeamSetupData>({
    teamName: initial?.teamName ?? '',
    categoryId: initial?.categoryId ?? '',
    institute: initial?.institute ?? '',
    city: initial?.city ?? ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A saved team only needs the final step
  const lastStep = WIZARD_STEPS.length - 1;
  const [step, setStep] = useState(teamSaved ? lastStep : 0);
  const [furthest, setFurthest] = useState(teamSaved ? lastStep : 0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [summaryCount, setSummaryCount] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const draft = useWizardDraft(TEAM_SETUP_DRAFT_KEY, data as unknown as Record<string, unknown>, step, !teamSaved);

  const update = (patch: Partial<TeamSetupData>) => {
    setData((prev) => ({ ...prev, ...patch }));
    // Clear the error of an edited field as soon as it is valid again
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch) as (keyof TeamSetupData)[]) {
        const fresh: SetupErrors =
          key === 'categoryId' ? validateCategory(patch.categoryId ?? '') : validateTeamDetails({ ...data, ...patch });
        if (!fresh[key]) delete next[key];
        else if (prev[key]) next[key] = fresh[key];
      }
      return next;
    });
  };

  /** Validates one field when it loses focus (only after the captain has typed something or tried to continue). */
  const blurField = (key: keyof TeamSetupData) => {
    if (teamSaved) return;
    const fresh: SetupErrors = validateTeamDetails(data);
    if (data[key].trim() || errors[key]) setErrors((prev) => ({ ...prev, [key]: fresh[key] }));
  };

  const goTo = (index: number) => {
    setDirection(index > step ? 1 : -1);
    setStep(index);
    setFurthest((f) => Math.max(f, index));
    setSummaryCount(0);
    setError(null);
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const focusErrors = (errs: SetupErrors) => {
    if (errs.categoryId) {
      const id = firstCategoryInputId('setup-category', categoriesState);
      window.requestAnimationFrame(() => document.getElementById(id)?.focus());
    } else {
      focusFirstError(errs, FIELD_ORDER);
    }
  };

  const next = () => {
    const errs = stepErrors(step, data, teamSaved);
    if (hasErrors(errs)) {
      setErrors(errs);
      setSummaryCount(Object.keys(errs).length);
      focusErrors(errs);
      return;
    }
    setErrors({});
    goTo(Math.min(step + 1, lastStep));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step < lastStep) {
      next();
      return;
    }
    if (!teamSaved) {
      // Re-check every step; send the captain back to the first one with a problem
      for (const s of [0, 2]) {
        const errs = stepErrors(s, data, teamSaved);
        if (hasErrors(errs)) {
          setErrors(errs);
          goTo(s);
          setSummaryCount(Object.keys(errs).length);
          focusErrors(errs);
          return;
        }
      }
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(data);
      draft.clear();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The team registration could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const restoreDraft = () => {
    const stored = draft.accept();
    if (!stored) return;
    const v = stored.values;
    setData((prev) => ({
      teamName: v.teamName ?? prev.teamName,
      institute: v.institute ?? prev.institute,
      city: v.city ?? prev.city,
      categoryId: categoriesState.categories.some((c) => c.id === v.categoryId) || categoriesState.loading ? v.categoryId ?? prev.categoryId : prev.categoryId
    }));
    const target = Math.max(0, Math.min(stored.step, lastStep));
    setFurthest(target);
    goTo(target);
  };

  const categoryName = categoriesState.categories.find((c) => c.id === data.categoryId)?.name ?? (data.categoryId ? 'Selected category' : '');
  const lockedHint = teamSaved ? 'Saved with your team. Please contact the GCDIS Secretariat to change it.' : undefined;
  const stepMeta = WIZARD_STEPS[step];

  return (
    <motion.section
      aria-labelledby="team-setup-heading"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="relative"
    >
      <span aria-hidden="true" className="absolute inset-0 translate-x-[6px] translate-y-[6px] rounded-[22px] bg-bento-ink" />
      <div className="relative space-y-5 rounded-[22px] border-[2.5px] border-bento-ink bg-white p-4 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-bento-ink bg-bento-lime text-bento-ink">
            <ClipboardList className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 id="team-setup-heading" className="text-lg font-extrabold uppercase leading-tight tracking-[-0.02em] text-bento-ink sm:text-xl">
              Complete Team Registration
            </h3>
            <p className="mt-1 text-xs font-medium text-slate-600">
              {teamSaved
                ? 'Your team has been saved. Please review the details and submit the registration to enter the championship in your category.'
                : 'Your captain account is active. Four short steps record your team and submit the registration. Further members may be added from the Team Members section once the team is saved.'}
            </p>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {draft.pending && <DraftRestoreBanner savedAt={draft.pending.savedAt} onRestore={restoreDraft} onDiscard={draft.discard} />}
        </AnimatePresence>

        <WizardProgress current={step} furthest={furthest} onJump={goTo} idPrefix="setup" />

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-extrabold uppercase tracking-tight text-bento-ink outline-none sm:text-lg"
          >
            <span className="font-mono text-xs text-slate-500">{String(step + 1).padStart(2, '0')} / </span>
            {stepMeta.label}
          </h4>

          <ErrorSummary count={summaryCount > 0 ? Object.values(errors).filter(Boolean).length : 0} id="setup-error-summary" />

          <StepPanel stepKey={stepMeta.id} direction={direction}>
            {step === 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <WizardField
                  id="setup-team-name"
                  label="Team Display Name"
                  hint={lockedHint ?? 'Shown on fixtures and certificates. Capital letters are used automatically.'}
                  error={errors.teamName}
                  counter={teamSaved ? undefined : { value: data.teamName.trim().length, max: TEAM_NAME_MAX }}
                  className="sm:col-span-2"
                >
                  <input
                    id="setup-team-name"
                    type="text"
                    required
                    maxLength={TEAM_NAME_MAX}
                    disabled={teamSaved || busy}
                    value={data.teamName}
                    onChange={(e) => update({ teamName: e.target.value })}
                    onBlur={() => blurField('teamName')}
                    aria-invalid={errors.teamName ? true : undefined}
                    aria-describedby={describedBy('setup-team-name', { hint: true, error: errors.teamName })}
                    className={`${wizardInput(Boolean(errors.teamName))} font-mono font-bold uppercase`}
                    placeholder="e.g. AERO SQUAD"
                    autoComplete="off"
                  />
                </WizardField>
                <WizardField
                  id="setup-institute"
                  label="Institution / College"
                  hint={lockedHint}
                  error={errors.institute}
                  counter={teamSaved ? undefined : { value: data.institute.trim().length, max: INSTITUTE_MAX }}
                >
                  <input
                    id="setup-institute"
                    type="text"
                    required
                    maxLength={INSTITUTE_MAX}
                    disabled={teamSaved || busy}
                    value={data.institute}
                    onChange={(e) => update({ institute: e.target.value })}
                    onBlur={() => blurField('institute')}
                    aria-invalid={errors.institute ? true : undefined}
                    aria-describedby={describedBy('setup-institute', { hint: Boolean(lockedHint), error: errors.institute })}
                    className={wizardInput(Boolean(errors.institute))}
                    autoComplete="organization"
                    placeholder="e.g. Galgotias University"
                  />
                </WizardField>
                <WizardField
                  id="setup-city"
                  label="City / State"
                  hint={lockedHint}
                  error={errors.city}
                  counter={teamSaved ? undefined : { value: data.city.trim().length, max: CITY_MAX }}
                >
                  <input
                    id="setup-city"
                    type="text"
                    required
                    maxLength={CITY_MAX}
                    disabled={teamSaved || busy}
                    value={data.city}
                    onChange={(e) => update({ city: e.target.value })}
                    onBlur={() => blurField('city')}
                    aria-invalid={errors.city ? true : undefined}
                    aria-describedby={describedBy('setup-city', { hint: Boolean(lockedHint), error: errors.city })}
                    className={wizardInput(Boolean(errors.city))}
                    autoComplete="address-level2"
                    placeholder="e.g. Greater Noida, Uttar Pradesh"
                  />
                </WizardField>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border-2 border-bento-ink bg-bento-paper p-4">
                  <p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-bento-ink">
                    <UserRound className="h-4 w-4" aria-hidden="true" />
                    Team captain
                    <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-bento-ink px-2 py-0.5 font-mono text-[9px] text-bento-lime">
                      <Lock className="h-3 w-3" aria-hidden="true" />
                      Account
                    </span>
                  </p>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="sr-only">Name</dt>
                      <dd className="font-extrabold text-slate-900">{captain?.name || 'Captain name not recorded'}</dd>
                    </div>
                    <div className="flex items-center gap-2 text-slate-700">
                      <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <dt className="sr-only">Email</dt>
                      <dd className="min-w-0 break-all font-mono text-xs">{captain?.email || 'Not available'}</dd>
                    </div>
                    <div className="flex items-center gap-2 text-slate-700">
                      <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <dt className="sr-only">Mobile</dt>
                      <dd className="font-mono text-xs">{captain?.mobile ? `+91 ${captain.mobile}` : 'Not recorded'}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[11px] leading-snug text-slate-600">
                    The captain is added to the roster automatically when the team is saved.
                  </p>
                </div>
                <div className="rounded-2xl border-2 border-slate-300 bg-white p-4">
                  <p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-bento-ink">
                    <Users className="h-4 w-4" aria-hidden="true" />
                    Team members
                  </p>
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    {teamSaved
                      ? `${memberCount} ${memberCount === 1 ? 'person is' : 'people are'} on the roster.`
                      : 'Members are added after the team is saved.'}
                  </p>
                  <ul className="mt-2 space-y-1 text-[12px] leading-snug text-slate-700">
                    <li>• FIDA line-up: five players on the field.</li>
                    <li>• Up to seven people per team, including the captain and at most three coaches.</li>
                    <li>• The full roster is required before the competition, not at registration.</li>
                  </ul>
                  {teamSaved && onGoToMembers && (
                    <button type="button" onClick={onGoToMembers} className={`${BTN_SECONDARY} mt-3 w-full`}>
                      <Users className="h-4 w-4" aria-hidden="true" />
                      Open Team Members
                    </button>
                  )}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-2">
                <CategoryCards
                  name="setup-category"
                  categoriesState={categoriesState}
                  value={data.categoryId}
                  onChange={(id) => update({ categoryId: id })}
                  error={errors.categoryId}
                  disabled={teamSaved || busy}
                />
                {teamSaved && <p className="text-[11px] text-slate-600">{lockedHint}</p>}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <ReviewSection
                  title="Team details"
                  onEdit={teamSaved ? undefined : () => goTo(0)}
                  editLabel="Edit team details"
                  rows={[
                    { label: 'Team name', value: <span className="font-mono uppercase">{data.teamName.trim()}</span> },
                    { label: 'Institution', value: data.institute.trim() },
                    { label: 'City / State', value: data.city.trim() }
                  ]}
                />
                <ReviewSection
                  title="Captain & members"
                  onEdit={() => goTo(1)}
                  editLabel="View captain and members"
                  rows={[
                    { label: 'Captain', value: captain?.name },
                    { label: 'Email', value: captain?.email && <span className="break-all font-mono text-xs">{captain.email}</span> },
                    { label: 'Members', value: teamSaved ? `${memberCount} on the roster` : 'Added after the team is saved' }
                  ]}
                />
                <ReviewSection
                  title="Category"
                  onEdit={teamSaved ? undefined : () => goTo(2)}
                  editLabel="Edit category"
                  rows={[{ label: 'Competition', value: categoryName }]}
                />
              </div>
            )}
          </StepPanel>

          {verificationGate && step === lastStep && (
            <VerificationRequiredNotice gate={verificationGate} action="submit the registration" />
          )}

          <div className="flex flex-col-reverse gap-3 border-t-2 border-dashed border-slate-200 pt-4 sm:flex-row sm:items-center">
            {step > 0 && (
              <button type="button" onClick={() => goTo(step - 1)} disabled={busy} className={BTN_SECONDARY}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </button>
            )}
            {!teamSaved && draft.savedAt && (
              <p className="text-[11px] font-semibold text-slate-500 sm:mr-auto" aria-live="polite">
                Draft saved in this browser
              </p>
            )}
            <div className="sm:ml-auto">
              {step < lastStep ? (
                <button type="submit" className={`${BTN_PRIMARY} w-full sm:w-auto`}>
                  Continue
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={busy || (blocked && teamSaved) || (!teamSaved && categoriesState.categories.length === 0)}
                  className={`${BTN_PRIMARY} w-full sm:w-auto`}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                  <span>
                    {busy
                      ? 'Saving…'
                      : blocked
                        ? teamSaved
                          ? 'Submit Registration (verify email first)'
                          : 'Save Team'
                        : teamSaved
                          ? 'Submit Registration'
                          : 'Save Team and Submit Registration'}
                  </span>
                </button>
              )}
            </div>
          </div>
          {error && (
            <FadeIn role="alert" className="rounded-xl border-2 border-rose-500 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
              {error}
            </FadeIn>
          )}
        </form>
      </div>
    </motion.section>
  );
}
