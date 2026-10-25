'use client';

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, Check, History, Pencil, Trophy, Users, X } from 'lucide-react';
import { formatFee, type CategoriesState } from './categories';
import { WIZARD_STEPS, type FieldErrors } from './registration-validation';
import { DURATION, EASE_OUT } from './motion';

/**
 * Building blocks of the team registration wizard, in the "bold bento" style of the public home page:
 * ink outlines, a lime accent and hard offset shadows used only on the primary action and the current step.
 * Every animation is transform/opacity only and the portal renders inside MotionConfig reducedMotion="user".
 */

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-ink';

export const wizardInput = (invalid: boolean) =>
  `w-full min-h-[48px] rounded-xl border-2 bg-white px-3.5 py-2.5 text-sm text-slate-900 transition-[border-color,box-shadow] duration-200 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-600 ${
    invalid
      ? 'border-rose-500 focus:shadow-[3px_3px_0_#f43f5e]'
      : 'border-slate-300 hover:border-slate-400 focus:border-bento-ink focus:shadow-[3px_3px_0_#C6F432]'
  }`;

export const BTN_PRIMARY = `inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border-[2.5px] border-bento-ink bg-bento-lime px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-bento-ink shadow-[3px_3px_0_#111] transition-[transform,box-shadow] duration-200 enabled:hover:-translate-x-0.5 enabled:hover:-translate-y-0.5 enabled:hover:shadow-[5px_5px_0_#111] enabled:active:translate-x-[3px] enabled:active:translate-y-[3px] enabled:active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transform-none ${FOCUS_RING}`;

export const BTN_SECONDARY = `inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border-[2.5px] border-bento-ink bg-white px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-bento-ink transition-colors duration-200 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

/**
 * Progress bar and step labels. Steps up to `furthest` can be revisited by clicking their label; the
 * current step is marked with aria-current="step".
 */
export function WizardProgress({
  current,
  furthest,
  onJump,
  idPrefix,
  compact = false
}: {
  current: number;
  furthest: number;
  onJump: (index: number) => void;
  idPrefix: string;
  /** Narrow containers: number above a short label at every width. */
  compact?: boolean;
}) {
  const sm = (cls: string) => (compact ? '' : cls);
  const reduce = useReducedMotion();
  const total = WIZARD_STEPS.length;
  const pct = ((current + 1) / total) * 100;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-slate-600" id={`${idPrefix}-progress-label`}>
          Step {current + 1} of {total}
        </p>
        <p className={`text-sm font-extrabold uppercase tracking-tight text-bento-ink ${sm('sm:hidden')}`} aria-hidden="true">
          {WIZARD_STEPS[current].label}
        </p>
      </div>
      <div
        role="progressbar"
        aria-labelledby={`${idPrefix}-progress-label`}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current + 1}
        aria-valuetext={`Step ${current + 1} of ${total}: ${WIZARD_STEPS[current].label}`}
        className="h-3 w-full overflow-hidden rounded-full border-2 border-bento-ink bg-white"
      >
        <motion.div
          className="h-full w-full origin-left bg-bento-lime"
          initial={false}
          animate={{ scaleX: pct / 100 }}
          transition={reduce ? { duration: 0 } : { duration: DURATION.slow, ease: EASE_OUT }}
        />
      </div>
      <ol className="grid grid-cols-4 gap-1.5 sm:gap-2" aria-label="Registration steps">
        {WIZARD_STEPS.map((step, i) => {
          const done = i < current;
          const isCurrent = i === current;
          const reachable = i <= furthest && !isCurrent;
          return (
            <li key={step.id} className="min-w-0">
              <button
                type="button"
                onClick={() => reachable && onJump(i)}
                disabled={!reachable && !isCurrent}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${step.label}${done ? ' (completed)' : ''}`}
                className={`group flex min-h-[44px] w-full flex-col items-center gap-1 rounded-lg px-0.5 py-1 text-center disabled:cursor-default ${sm('sm:flex-row sm:gap-2 sm:text-left')} ${FOCUS_RING} ${
                  reachable ? 'cursor-pointer hover:bg-slate-100' : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-bento-ink font-mono text-[11px] font-black transition-colors duration-200 ${
                    isCurrent
                      ? 'bg-bento-ink text-bento-lime shadow-[2px_2px_0_#C6F432]'
                      : done
                        ? 'bg-bento-lime text-bento-ink'
                        : 'bg-white text-slate-600'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span
                  className={`hidden min-w-0 text-[11px] font-extrabold uppercase leading-tight tracking-wide ${sm('sm:block')} ${
                    isCurrent ? 'text-bento-ink' : done ? 'text-slate-700' : 'text-slate-500'
                  }`}
                >
                  {step.label}
                </span>
                <span className={`text-[10px] font-bold uppercase ${sm('sm:hidden')} ${isCurrent ? 'text-bento-ink' : 'text-slate-600'}`} aria-hidden="true">
                  {step.short}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

/** ids of the hint and error paragraphs of a field, for aria-describedby. */
export function describedBy(id: string, opts: { hint?: boolean; error?: string }): string | undefined {
  const ids = [opts.hint ? `${id}-hint` : '', opts.error ? `${id}-error` : ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export function WizardField({
  id,
  label,
  hint,
  error,
  counter,
  children,
  className
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  /** e.g. { value: 12, max: 80 } shows "12/80" next to the label. */
  counter?: { value: number; max: number };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-end justify-between gap-2">
        <label htmlFor={id} className="text-xs font-extrabold uppercase tracking-wide text-slate-800">
          {label}
        </label>
        {counter && (
          <span
            aria-hidden="true"
            className={`font-mono text-[10px] font-bold ${counter.value > counter.max ? 'text-rose-600' : 'text-slate-500'}`}
          >
            {counter.value}/{counter.max}
          </span>
        )}
      </div>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-[11px] leading-snug text-slate-600">
          {hint}
        </p>
      )}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key="error"
            id={`${id}-error`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE_OUT }}
            className="mt-1.5 flex items-start gap-1.5 text-[12px] font-semibold text-rose-700"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Focuses (and scrolls to) the first field of `order` that has an error. */
export function focusFirstError<K extends string>(errors: FieldErrors<K>, order: { key: K; id: string }[]): void {
  const first = order.find((f) => errors[f.key]);
  if (!first) return;
  window.requestAnimationFrame(() => {
    const el = document.getElementById(first.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

/** Short summary announced when a step has errors. */
export function ErrorSummary({ count, id }: { count: number; id: string }) {
  if (count === 0) return null;
  return (
    <div id={id} role="alert" className="flex items-start gap-2 rounded-xl border-2 border-rose-500 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {count === 1 ? 'One field needs your attention' : `${count} fields need your attention`} before you continue.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Category cards                                                      */
/* ------------------------------------------------------------------ */

/** Radio cards for the competition category (large tap targets, arrow-key navigation via native radios). */
export function CategoryCards({
  name,
  categoriesState,
  value,
  onChange,
  error,
  disabled
}: {
  name: string;
  categoriesState: CategoriesState;
  value: string;
  onChange: (id: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { categories, loading } = categoriesState;
  const errorId = `${name}-error`;
  const loadErrorId = `${name}-load-error`;
  if (loading) {
    return (
      <div role="status" className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border-2 border-slate-200 bg-slate-100 motion-reduce:animate-none" />
        ))}
        <span className="sr-only">Loading the competition categories…</span>
      </div>
    );
  }
  return (
    <fieldset aria-describedby={[error ? errorId : '', categoriesState.error ? loadErrorId : ''].filter(Boolean).join(' ') || undefined}>
      <legend className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-800">Competition category</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {categories.map((c, i) => {
          const checked = value === c.id;
          const inputId = `${name}-${c.id}`;
          return (
            <label
              key={c.id}
              htmlFor={inputId}
              className={`group relative block cursor-pointer rounded-2xl ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-0 translate-x-[5px] translate-y-[5px] rounded-2xl bg-bento-ink transition-opacity duration-200 ${checked ? 'opacity-100' : 'opacity-0'}`}
              />
              <span
                className={`relative flex h-full min-h-[112px] flex-col gap-2 rounded-2xl border-[2.5px] p-4 transition-[transform,background-color,border-color] duration-200 motion-reduce:transition-none group-has-[:focus-visible]:outline group-has-[:focus-visible]:outline-[3px] group-has-[:focus-visible]:outline-offset-2 group-has-[:focus-visible]:outline-bento-ink ${
                  checked
                    ? '-translate-x-0.5 -translate-y-0.5 border-bento-ink bg-bento-lime'
                    : error
                      ? 'border-rose-400 bg-white hover:border-bento-ink'
                      : 'border-slate-300 bg-white hover:border-bento-ink'
                }`}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={name}
                  value={c.id}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(c.id)}
                  aria-invalid={error ? true : undefined}
                  className="sr-only"
                  data-first-radio={i === 0 ? 'true' : undefined}
                />
                <span className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-extrabold uppercase tracking-tight text-bento-ink">
                    <Trophy className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {c.name}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-bento-ink ${checked ? 'bg-bento-ink text-bento-lime' : 'bg-white'}`}
                  >
                    {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                </span>
                <span className="mt-auto flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-slate-700">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    Up to {Math.min(c.maxTeamSize || 7, 7)} people
                  </span>
                  <span>Entry fee: {formatFee(c.entryFee, c.currency)} (incl. GST)</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {categoriesState.error && (
        <p id={loadErrorId} role="alert" className="mt-2 text-[12px] font-semibold text-rose-700">
          {categoriesState.error}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-2 flex items-start gap-1.5 text-[12px] font-semibold text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

/** id of the element to focus for a category error (the first radio). */
export function firstCategoryInputId(name: string, categoriesState: CategoriesState): string {
  const first = categoriesState.categories[0];
  return first ? `${name}-${first.id}` : name;
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

export function ReviewSection({
  title,
  rows,
  onEdit,
  editLabel
}: {
  title: string;
  rows: { label: string; value: React.ReactNode }[];
  onEdit?: () => void;
  editLabel?: string;
}) {
  return (
    <section className="rounded-2xl border-2 border-bento-ink bg-white">
      <div className="flex items-center justify-between gap-2 border-b-2 border-bento-ink px-4 py-2.5">
        <h4 className="text-xs font-extrabold uppercase tracking-wider text-bento-ink">{title}</h4>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={editLabel ?? `Edit ${title}`}
            className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-extrabold uppercase tracking-wider text-bento-ink underline-offset-4 hover:bg-bento-lime hover:underline ${FOCUS_RING}`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </button>
        )}
      </div>
      <dl className="divide-y divide-slate-200">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-1 gap-0.5 px-4 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
            <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-600">{row.label}</dt>
            <dd className="min-w-0 break-words text-sm font-semibold text-slate-900">{row.value || <span className="text-slate-500">Not provided</span>}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Draft restore                                                       */
/* ------------------------------------------------------------------ */

function formatSavedAt(savedAt: number): string {
  if (!savedAt) return 'earlier';
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function DraftRestoreBanner({
  savedAt,
  onRestore,
  onDiscard,
  compact = false
}: {
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
  /** Narrow containers: actions below the message at every width. */
  compact?: boolean;
}) {
  return (
    <motion.div
      role="region"
      aria-label="Saved draft"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
      className={`flex flex-col gap-3 rounded-2xl border-2 border-bento-ink bg-bento-paper p-3.5 ${compact ? '' : 'sm:flex-row sm:items-center'}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bento-ink text-bento-lime" aria-hidden="true">
          <History className="h-4 w-4" />
        </span>
        <p className="text-xs font-semibold leading-snug text-slate-800">
          <span className="block font-extrabold uppercase tracking-wide text-bento-ink">Continue where you left off?</span>
          A draft of this form was saved in this browser ({formatSavedAt(savedAt)}). Passwords are never saved.
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={onRestore} className={`${BTN_PRIMARY} min-h-[44px] flex-1 px-4 ${compact ? '' : 'sm:flex-none'}`}>
          Restore draft
        </button>
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Discard saved draft"
          className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border-2 border-bento-ink bg-white text-bento-ink hover:bg-slate-100 ${FOCUS_RING}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </motion.div>
  );
}

/** Slide between steps (direction-aware); opacity only when reduced motion is requested. */
export function StepPanel({ stepKey, direction, children }: { stepKey: string; direction: 1 | -1; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={stepKey}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 * direction }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
