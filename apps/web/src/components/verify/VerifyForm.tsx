'use client';

import React, { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Search } from 'lucide-react';
import { normalizeCertificateCode } from '@/lib/certificates';

interface VerifyFormProps {
  defaultValue?: string;
  /** Visual theme: `dark` for the verification result page, `light` elsewhere. */
  tone?: 'dark' | 'light';
  label?: string;
}

/** Certificate code entry form; navigates to the verification page for the entered code. */
export function VerifyForm({ defaultValue = '', tone = 'dark', label = 'Certificate code' }: VerifyFormProps) {
  const router = useRouter();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = normalizeCertificateCode(value);
    if (!code) {
      setError('Please enter a certificate code in the format printed on the certificate, for example GCDIS-CERT-2026-XXXXXXXX.');
      return;
    }
    setError(null);
    router.push(`/verify/${encodeURIComponent(code)}`);
  };

  const dark = tone === 'dark';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-2 text-left">
      <label htmlFor={inputId} className={`block text-xs font-bold ${dark ? 'text-slate-300' : 'text-slate-700'}`}>
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${dark ? 'text-slate-500' : 'text-slate-400'}`}
            aria-hidden="true"
          />
          <input
            id={inputId}
            name="code"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder="GCDIS-CERT-2026-XXXXXXXX"
            className={`w-full rounded-lg border py-2.5 pl-9 pr-3 font-mono text-sm uppercase placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-[#22C55E]/40 ${
              dark
                ? 'border-slate-700 bg-slate-950 text-white placeholder:text-slate-500 focus:border-[#22C55E]'
                : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#15803D]'
            }`}
          />
        </div>
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#15803D] px-5 py-2.5 text-xs font-black uppercase tracking-wider text-white transition-colors hover:bg-[#166534]"
        >
          Verify
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className={`text-xs font-medium ${dark ? 'text-rose-300' : 'text-rose-700'}`}>
          {error}
        </p>
      )}
    </form>
  );
}
