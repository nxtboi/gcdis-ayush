'use client';

import React from 'react';
import { Asterisk } from 'lucide-react';
import { LightSweep } from './Effects';
import { Marquee } from './Marquee';

/** Tilted lime band with the Centre's training areas and services, scrolling continuously. */
export function LimeMarquee({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="relative overflow-hidden bg-bento-paper py-8">
      <div className="group relative -mx-4 -rotate-[1.5deg] overflow-hidden border-y-[2.5px] border-bento-ink bg-bento-lime py-4 shadow-[0_6px_0_#111]">
        <Marquee label="Training areas and services" speed={55} trackClassName="gap-8 pr-8">
          {items.map((item) => (
            <span key={item} className="flex shrink-0 items-center gap-8 whitespace-nowrap text-lg font-extrabold uppercase tracking-tight text-bento-ink sm:text-2xl">
              {item}
              <Asterisk className="h-6 w-6" aria-hidden="true" />
            </span>
          ))}
        </Marquee>
        <LightSweep />
      </div>
    </div>
  );
}
