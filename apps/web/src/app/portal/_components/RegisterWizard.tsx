'use client';

import React, { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Loader2, Users } from 'lucide-react';
import type { CategoriesState } from './categories';
import type { RegisterFormData } from './AuthView';
import GoogleSignInButton, { type GoogleAuthUser } from './GoogleSignInButton';
import { PasswordInput } from './AuthFields';
import { PasswordPolicy } from './PasswordPolicy';
import {
  CAPTAIN_NAME_MAX,
  CITY_MAX,
  INSTITUTE_MAX,
  TEAM_NAME_MAX,
  WIZARD_STEPS,
  hasErrors,
  validateCaptain,
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
  FOCUS_RING,
  ReviewSection,
  StepPanel,
  WizardField,
  WizardProgress,
  describedBy,
  firstCategoryInputId,
  focusFirstError,
  wizardInput
} from './WizardParts';
import { REGISTER_DRAFT_KEY, useWizardDraft } from './wizard-draft';

type RegKey = keyof RegisterFormData | 'terms';
type RegErrors = FieldErrors<RegKey>;

const FIELD_ORDER: { key: RegKey; id: string }[] = [
  { key: 'teamName', id: 'reg-team-name' },
  { key: 'institute', id: 'reg-institute' },
  { key: 'city', id: 'reg-city' },
  { key: 'captainName', id: 'reg-captain-name' },
  { key: 'captainMobile', id: 'reg-captain-mobile' },
  { key: 'captainEmail', id: 'reg-captain-email' },
  { key: 'password', id: 'reg-password' },
  { key: 'confirmPassword', id: 'reg-confirm-password' },
  { key: 'terms', id: 'terms' }
];

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
const LAST_STEP = WIZARD_STEPS.length - 1;

function errorsForStep(step: number, data: RegisterFormData, termsAccepted: boolean): RegErrors {
  if (step === 0) return validateTeamDetails(data);
  if (step === 1) return validateCaptain(data);
  if (step === 2) {
    const e = validateCategory(data.category);
    return e.categoryId ? { category: e.categoryId } : {};
  }
  return termsAccepted ? {} : { terms: 'Please confirm the FIDA rulebook and institutional approval statement to continue.' };
}

interface RegisterWizardProps {
  regData: RegisterFormData;
  setRegData: (value: RegisterFormData) => void;
  handleRegisterSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  categoriesState: CategoriesState;
  onGoogleSuccess: (user: GoogleAuthUser) => void;
  onGoogleError: (message: string) => void;
}

/**
 * Public team registration as a four-step wizard: Team details → Captain & members → Category → Review &
 * submit. Inline validation mirrors the API rules; the draft (never the passwords) is autosaved in this
 * browser. The final step submits through `handleRegisterSubmit` exactly as the single-page form did
 * (POST /auth/register, then POST /teams and POST /registrations).
 */
export default function RegisterWizard({
  regData,
  setRegData,
  handleRegisterSubmit,
  isSubmitting,
  categoriesState,
  onGoogleSuccess,
  onGoogleError
}: RegisterWizardProps) {
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [errors, setErrors] = useState<RegErrors>({});
  const [summaryCount, setSummaryCount] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const draft = useWizardDraft(REGISTER_DRAFT_KEY, regData as unknown as Record<string, unknown>, step);

  const set = (patch: Partial<RegisterFormData>) => {
    const nextData = { ...regData, ...patch };
    setRegData(nextData);
    // Errors already shown update live (and disappear once fixed)
    setErrors((prev) => {
      if (!hasErrors(prev)) return prev;
      const fresh: RegErrors = { ...validateTeamDetails(nextData), ...validateCaptain(nextData) };
      const cat = validateCategory(nextData.category);
      if (cat.categoryId) fresh.category = cat.categoryId;
      const next: RegErrors = { ...prev };
      for (const key of Object.keys(prev) as RegKey[]) {
        if (key === 'terms') continue;
        if (fresh[key]) next[key] = fresh[key];
        else delete next[key];
      }
      return next;
    });
  };

  /** Validate a field when it loses focus, once it has a value (so empty fields are not flagged while tabbing). */
  const blur = (key: RegKey) => {
    const value = key === 'terms' ? '' : regData[key];
    if (!value && !errors[key]) return;
    const fresh: RegErrors = { ...validateTeamDetails(regData), ...validateCaptain(regData) };
    setErrors((prev) => ({ ...prev, [key]: fresh[key] }));
  };

  const goTo = (index: number) => {
    setDirection(index > step ? 1 : -1);
    setStep(index);
    setFurthest((f) => Math.max(f, index));
    setSummaryCount(0);
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const showErrors = (errs: RegErrors) => {
    setErrors(errs);
    setSummaryCount(Object.values(errs).filter(Boolean).length);
    if (errs.category) {
      const id = firstCategoryInputId('reg-category', categoriesState);
      window.requestAnimationFrame(() => document.getElementById(id)?.focus());
    } else {
      focusFirstError(errs, FIELD_ORDER);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    if (step < LAST_STEP) {
      e.preventDefault();
      const errs = errorsForStep(step, regData, termsAccepted);
      if (hasErrors(errs)) {
        showErrors(errs);
        return;
      }
      setErrors({});
      goTo(step + 1);
      return;
    }
    // Final step: every step must be valid before the existing submit handler runs
    for (let s = 0; s <= LAST_STEP; s++) {
      const errs = errorsForStep(s, regData, termsAccepted);
      if (hasErrors(errs)) {
        e.preventDefault();
        if (s !== step) goTo(s);
        showErrors(errs);
        return;
      }
    }
    handleRegisterSubmit(e);
  };

  const restoreDraft = () => {
    const stored = draft.accept();
    if (!stored) return;
    const v = stored.values;
    setRegData({
      ...regData,
      teamName: v.teamName ?? regData.teamName,
      institute: v.institute ?? regData.institute,
      city: v.city ?? regData.city,
      category: v.category ?? regData.category,
      captainName: v.captainName ?? regData.captainName,
      captainEmail: v.captainEmail ?? regData.captainEmail,
      captainMobile: (v.captainMobile ?? regData.captainMobile).replace(/\D/g, '').slice(0, 10)
    });
    // Passwords are never stored: resume no later than the captain step so they are entered again
    goTo(Math.max(0, Math.min(stored.step, 1)));
  };

  const categoryName = categoriesState.categories.find((c) => c.id === regData.category)?.name ?? '';
  const meta = WIZARD_STEPS[step];

  return (
    <motion.form
      key="register"
      onSubmit={onSubmit}
      noValidate
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="mt-6 space-y-5"
      aria-labelledby="reg-step-heading"
    >
      <AnimatePresence initial={false}>
        {draft.pending && <DraftRestoreBanner savedAt={draft.pending.savedAt} onRestore={restoreDraft} onDiscard={draft.discard} compact />}
      </AnimatePresence>

      <WizardProgress current={step} furthest={furthest} onJump={goTo} idPrefix="reg" compact />

      <h2
        id="reg-step-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-extrabold uppercase tracking-tight text-bento-ink outline-none"
      >
        <span className="font-mono text-xs text-slate-500">{String(step + 1).padStart(2, '0')} / </span>
        {meta.label}
      </h2>

      <ErrorSummary count={summaryCount > 0 ? Object.values(errors).filter(Boolean).length : 0} id="reg-error-summary" />

      <StepPanel stepKey={meta.id} direction={direction}>
        {step === 0 && (
          <div className="space-y-4">
            <WizardField
              id="reg-team-name"
              label="Team Display Name"
              hint="Shown on fixtures and certificates."
              error={errors.teamName}
              counter={{ value: regData.teamName.trim().length, max: TEAM_NAME_MAX }}
            >
              <input
                id="reg-team-name"
                type="text"
                required
                maxLength={TEAM_NAME_MAX}
                value={regData.teamName}
                onChange={(e) => set({ teamName: e.target.value })}
                onBlur={() => blur('teamName')}
                aria-invalid={errors.teamName ? true : undefined}
                aria-describedby={describedBy('reg-team-name', { hint: true, error: errors.teamName })}
                className={`${wizardInput(Boolean(errors.teamName))} font-mono font-bold uppercase`}
                placeholder="e.g. AERO SQUAD"
                autoComplete="off"
              />
            </WizardField>
            <WizardField
              id="reg-institute"
              label="Institution / College"
              error={errors.institute}
              counter={{ value: regData.institute.trim().length, max: INSTITUTE_MAX }}
            >
              <input
                id="reg-institute"
                type="text"
                required
                maxLength={INSTITUTE_MAX}
                autoComplete="organization"
                value={regData.institute}
                onChange={(e) => set({ institute: e.target.value })}
                onBlur={() => blur('institute')}
                aria-invalid={errors.institute ? true : undefined}
                aria-describedby={describedBy('reg-institute', { error: errors.institute })}
                className={wizardInput(Boolean(errors.institute))}
                placeholder="e.g. National Institute of Technology"
              />
            </WizardField>
            <WizardField id="reg-city" label="City / State" error={errors.city} counter={{ value: regData.city.trim().length, max: CITY_MAX }}>
              <input
                id="reg-city"
                type="text"
                required
                maxLength={CITY_MAX}
                autoComplete="address-level2"
                value={regData.city}
                onChange={(e) => set({ city: e.target.value })}
                onBlur={() => blur('city')}
                aria-invalid={errors.city ? true : undefined}
                aria-describedby={describedBy('reg-city', { error: errors.city })}
                className={wizardInput(Boolean(errors.city))}
                placeholder="e.g. Greater Noida, Uttar Pradesh"
              />
            </WizardField>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <WizardField id="reg-captain-name" label="Captain Full Name" error={errors.captainName}>
                <input
                  id="reg-captain-name"
                  type="text"
                  required
                  maxLength={CAPTAIN_NAME_MAX}
                  autoComplete="name"
                  value={regData.captainName}
                  onChange={(e) => set({ captainName: e.target.value })}
                  onBlur={() => blur('captainName')}
                  aria-invalid={errors.captainName ? true : undefined}
                  aria-describedby={describedBy('reg-captain-name', { error: errors.captainName })}
                  className={wizardInput(Boolean(errors.captainName))}
                  placeholder="e.g. Priya Sharma"
                />
              </WizardField>
              <WizardField id="reg-captain-mobile" label="Captain Mobile (+91)" hint="10 digits, without +91." error={errors.captainMobile}>
                <input
                  id="reg-captain-mobile"
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  required
                  autoComplete="tel-national"
                  value={regData.captainMobile}
                  onChange={(e) => set({ captainMobile: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                  onBlur={() => blur('captainMobile')}
                  aria-invalid={errors.captainMobile ? true : undefined}
                  aria-describedby={describedBy('reg-captain-mobile', { hint: true, error: errors.captainMobile })}
                  className={`${wizardInput(Boolean(errors.captainMobile))} font-mono`}
                  placeholder="9876543210"
                />
              </WizardField>
            </div>
            <WizardField
              id="reg-captain-email"
              label="Captain Email Address"
              hint="A six-digit verification code is sent here. The address must be verified before the registration is submitted and the entry fee is paid."
              error={errors.captainEmail}
            >
              <input
                id="reg-captain-email"
                type="email"
                required
                autoComplete="email"
                value={regData.captainEmail}
                onChange={(e) => set({ captainEmail: e.target.value })}
                onBlur={() => blur('captainEmail')}
                aria-invalid={errors.captainEmail ? true : undefined}
                aria-describedby={describedBy('reg-captain-email', { hint: true, error: errors.captainEmail })}
                className={wizardInput(Boolean(errors.captainEmail))}
                placeholder="captain@institution.ac.in"
              />
            </WizardField>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <WizardField id="reg-password" label="Password" error={errors.password}>
                <PasswordInput
                  id="reg-password"
                  describedBy={['reg-password-policy', errors.password ? 'reg-password-error' : ''].filter(Boolean).join(' ')}
                  invalid={Boolean(errors.password)}
                  inputClassName={wizardInput(Boolean(errors.password))}
                  value={regData.password}
                  onChange={(v) => set({ password: v })}
                  autoComplete="new-password"
                />
              </WizardField>
              <WizardField id="reg-confirm-password" label="Confirm Password" error={errors.confirmPassword}>
                <PasswordInput
                  id="reg-confirm-password"
                  describedBy={errors.confirmPassword ? 'reg-confirm-password-error' : undefined}
                  invalid={Boolean(errors.confirmPassword)}
                  inputClassName={wizardInput(Boolean(errors.confirmPassword))}
                  value={regData.confirmPassword}
                  onChange={(v) => set({ confirmPassword: v })}
                  autoComplete="new-password"
                />
              </WizardField>
            </div>
            <PasswordPolicy id="reg-password-policy" password={regData.password} email={regData.captainEmail} />
            <div className="flex items-start gap-2.5 rounded-xl border-2 border-dashed border-slate-300 p-3 text-[12px] leading-snug text-slate-700">
              <Users className="mt-0.5 h-4 w-4 shrink-0 text-bento-ink" aria-hidden="true" />
              <p>
                <span className="font-extrabold text-bento-ink">Team members</span> are added from the Team Members section of the
                dashboard once the team is saved: up to seven people including the captain, with five players on the field.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <CategoryCards
            name="reg-category"
            categoriesState={categoriesState}
            value={regData.category}
            onChange={(id) => set({ category: id })}
            error={errors.category}
          />
        )}

        {step === 3 && (
          <div className="space-y-4">
            <ReviewSection
              title="Team details"
              onEdit={() => goTo(0)}
              editLabel="Edit team details"
              rows={[
                { label: 'Team name', value: <span className="font-mono uppercase">{regData.teamName.trim()}</span> },
                { label: 'Institution', value: regData.institute.trim() },
                { label: 'City / State', value: regData.city.trim() }
              ]}
            />
            <ReviewSection
              title="Captain"
              onEdit={() => goTo(1)}
              editLabel="Edit captain details"
              rows={[
                { label: 'Name', value: regData.captainName.trim() },
                { label: 'Mobile', value: regData.captainMobile && <span className="font-mono">+91 {regData.captainMobile}</span> },
                { label: 'Email', value: <span className="break-all font-mono text-xs">{regData.captainEmail.trim()}</span> },
                { label: 'Password', value: regData.password ? 'Set (hidden)' : '' }
              ]}
            />
            <ReviewSection title="Category" onEdit={() => goTo(2)} editLabel="Edit category" rows={[{ label: 'Competition', value: categoryName }]} />

            <div>
              <div
                className={`flex items-start gap-3 rounded-xl border-2 p-3 ${errors.terms ? 'border-rose-500 bg-rose-50' : 'border-slate-300 bg-white'}`}
              >
                <input
                  type="checkbox"
                  id="terms"
                  required
                  checked={termsAccepted}
                  onChange={(e) => {
                    setTermsAccepted(e.target.checked);
                    if (e.target.checked) setErrors((prev) => ({ ...prev, terms: undefined }));
                  }}
                  aria-invalid={errors.terms ? true : undefined}
                  aria-describedby={errors.terms ? 'terms-error' : undefined}
                  className={`mt-0.5 h-5 w-5 shrink-0 accent-[#111111] ${FOCUS_RING}`}
                />
                <label htmlFor="terms" className="text-[12px] leading-snug text-slate-700">
                  I confirm that our team will comply with the current FIDA rulebook for the selected class and will submit a
                  signed institutional approval letter before the competition.
                </label>
              </div>
              {errors.terms && (
                <p id="terms-error" className="mt-1.5 text-[12px] font-semibold text-rose-700">
                  {errors.terms}
                </p>
              )}
            </div>
          </div>
        )}
      </StepPanel>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
        {step > 0 && (
          <button type="button" onClick={() => goTo(step - 1)} disabled={isSubmitting} className={BTN_SECONDARY}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </button>
        )}
        <button type="submit" disabled={isSubmitting} className={`${BTN_PRIMARY} w-full sm:ml-auto sm:w-auto`}>
          {step < LAST_STEP ? (
            <>
              Continue
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          ) : isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Registering team…
            </>
          ) : (
            <>
              Register team
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>
      </div>
      {draft.savedAt && (
        <p className="text-center text-[11px] font-semibold text-slate-500" aria-live="polite">
          Draft saved in this browser. Passwords are never saved.
        </p>
      )}

      {step === 0 && (
        <GoogleSignInButton mode="register" onGoogleSuccess={onGoogleSuccess} onGoogleError={onGoogleError} disabled={isSubmitting} />
      )}
    </motion.form>
  );
}
