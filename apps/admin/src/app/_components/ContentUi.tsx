'use client';

import React, { useId } from 'react';

/** Shared form building blocks for the site content screens. */
export const INPUT_CLASS =
  'w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#22C55E] transition-colors aria-[invalid=true]:border-rose-500';

export const CARD_CLASS = 'bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; required?: boolean }) => React.ReactNode;
}

/** Label, control, hint and error message wired together for assistive technology. */
export function Field({ label, error, hint, required, className = '', children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-bold text-slate-300 mb-1.5">
        {label}
        {required && (
          <span className="text-rose-300" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, required })}
      {hint && (
        <p id={hintId} className="mt-1 text-[10px] text-slate-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Hide the visible label (the accessible name is kept). */
  compact?: boolean;
}

/** Accessible on/off switch (role="switch"). */
export function Toggle({ checked, onChange, label, description, disabled = false, compact = false }: ToggleProps) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      {!compact && (
        <div className="min-w-0">
          <span className="block text-xs font-bold text-slate-300" aria-hidden="true">
            {label}
          </span>
          {description && (
            <span id={`${id}-description`} className="block text-[10px] text-slate-400">
              {description}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={!compact && description ? `${id}-description` : undefined}
        title={compact ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22C55E] ${
          checked ? 'bg-[#22C55E]' : 'bg-slate-700'
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  );
}

/** Small up/down controls for keyboard-accessible reordering. */
export function ReorderButtons({
  label,
  canMoveUp,
  canMoveDown,
  onMove,
  disabled = false,
  orientation = 'vertical'
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  disabled?: boolean;
  orientation?: 'vertical' | 'horizontal';
}) {
  const base =
    'w-7 h-7 flex items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  const earlier = orientation === 'vertical' ? 'up' : 'earlier';
  const later = orientation === 'vertical' ? 'down' : 'later';
  return (
    <div className={`flex ${orientation === 'vertical' ? 'flex-col' : 'flex-row'} gap-1`}>
      <button type="button" className={base} disabled={disabled || !canMoveUp} onClick={() => onMove(-1)} aria-label={`Move ${label} ${earlier}`} title={`Move ${earlier}`}>
        <span aria-hidden="true">{orientation === 'vertical' ? '▲' : '◀'}</span>
      </button>
      <button type="button" className={base} disabled={disabled || !canMoveDown} onClick={() => onMove(1)} aria-label={`Move ${label} ${later}`} title={`Move ${later}`}>
        <span aria-hidden="true">{orientation === 'vertical' ? '▼' : '▶'}</span>
      </button>
    </div>
  );
}

export function SectionHeading({ id, title, description, icon: Icon, actions }: {
  id: string;
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-black text-white tracking-tight flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-[#22C55E]" aria-hidden={true} />}
          <span>{title}</span>
        </h2>
        {description && <p className="text-[11px] text-slate-400 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
