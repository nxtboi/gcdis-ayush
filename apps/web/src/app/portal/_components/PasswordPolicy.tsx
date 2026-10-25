'use client';

import React from 'react';
import { Check, Circle, ShieldCheck, X } from 'lucide-react';
import { passwordChecks } from '@/lib/password-policy';

/**
 * Password policy with live checks for the rules that can be verified in the browser.
 * The breached-password rule is verified by the API on submission.
 */
export function PasswordPolicy({ password, email, id }: { password: string; email?: string | null; id?: string }) {
  const checks = passwordChecks(password, email);
  const touched = password.length > 0;
  return (
    <div id={id} className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5">
      <p className="text-[11px] font-bold text-slate-700">Password requirements</p>
      <ul className="mt-1.5 space-y-1" aria-live="polite">
        {checks.map((check) => {
          const state =
            check.id === 'breached' ? 'server' : !touched || check.met === null ? 'idle' : check.met ? 'met' : 'unmet';
          return (
            <li key={check.id} className="flex items-start gap-2 text-[11px] leading-snug">
              <span className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                {state === 'met' && <Check className="h-3.5 w-3.5 text-[#15803D]" />}
                {state === 'unmet' && <X className="h-3.5 w-3.5 text-rose-600" />}
                {state === 'idle' && <Circle className="h-2.5 w-2.5 text-slate-400" />}
                {state === 'server' && <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />}
              </span>
              <span
                className={`transition-colors duration-200 ${
                  state === 'met' ? 'text-[#15803D]' : state === 'unmet' ? 'text-rose-700' : 'text-slate-500'
                }`}
              >
                {check.label}
                <span className="sr-only">
                  {state === 'met' ? ' (met)' : state === 'unmet' ? ' (not met)' : state === 'server' ? ' (checked by the server)' : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
