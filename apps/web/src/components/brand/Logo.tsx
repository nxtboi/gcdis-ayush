import React from 'react';
import Image from 'next/image';

interface LogoProps {
  /** Rendered diameter in pixels. */
  size?: number;
  /** Show the "GCDIS / Galgotias University" wordmark next to the seal. */
  withWordmark?: boolean;
  /** Wordmark colour scheme: light text for dark backgrounds, dark text for light ones. */
  tone?: 'light' | 'dark';
  priority?: boolean;
  className?: string;
}

/** Official Galgotias University GCDIS seal, optionally with the wordmark. */
export function Logo({ size = 40, withWordmark = false, tone = 'light', priority = false, className = '' }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Image
        src="/images/gcdis-logo.png"
        alt={withWordmark ? '' : 'GCDIS, Galgotias University'}
        width={size}
        height={size}
        priority={priority}
        className="shrink-0 rounded-full bg-white shadow-sm ring-1 ring-white/20"
        style={{ width: size, height: size }}
      />
      {withWordmark && (
        <span className="flex flex-col leading-none">
          <span className={`text-base font-black tracking-wider ${tone === 'light' ? 'text-white' : 'text-slate-950'}`}>GCDIS</span>
          <span
            className={`mt-1 font-mono text-[9px] font-bold uppercase tracking-[0.18em] ${tone === 'light' ? 'text-slate-400' : 'text-slate-500'}`}
          >
            Galgotias University
          </span>
        </span>
      )}
    </span>
  );
}
