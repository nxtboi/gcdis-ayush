'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Eye, EyeOff, Loader2, Lock } from 'lucide-react';

/** Form primitives shared by the portal sign-in, registration and password pages. */

export const inputBase =
  'w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 text-sm text-slate-900 transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-slate-400 focus:border-[#22C55E] focus:bg-white focus:outline-none focus:ring-4 focus:ring-[#22C55E]/15';

export function Field({
  id,
  label,
  children,
  aside
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-bold text-slate-700">
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  withIcon = false,
  describedBy,
  invalid,
  inputClassName
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  withIcon?: boolean;
  describedBy?: string;
  invalid?: boolean;
  /** Replaces the default input style (e.g. the registration wizard's bold inputs). */
  inputClassName?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      {withIcon && (
        <Lock
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
      )}
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        required
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClassName ?? inputBase} ${withIcon ? 'pl-9' : 'pl-3'} pr-10 font-mono`}
        placeholder="••••••••••••"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E]"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

export function SubmitButton({ busy, idle, busyLabel }: { busy: boolean; idle: string; busyLabel: string }) {
  return (
    <motion.button
      type="submit"
      disabled={busy}
      whileTap={busy ? undefined : { scale: 0.985 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="group mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[#22C55E] py-3.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md shadow-[#22C55E]/20 transition-[background-color,box-shadow] duration-200 hover:bg-[#15803D] hover:text-white hover:shadow-lg hover:shadow-[#22C55E]/30 disabled:cursor-wait disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15803D]"
    >
      {busy ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{busyLabel}</span>
        </>
      ) : (
        <>
          <span>{idle}</span>
          <ArrowRight
            className="h-4 w-4 transition-transform duration-300 ease-out group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            aria-hidden="true"
          />
        </>
      )}
    </motion.button>
  );
}
