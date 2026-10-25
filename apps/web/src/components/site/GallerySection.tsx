'use client';

/**
 * Accessible image viewer for console-managed gallery images (used by the home page photo mosaic,
 * components/home-bento/AwardsSection.tsx). Escape closes, arrow keys move between images, Tab is trapped.
 * Render it inside <AnimatePresence> so it fades out on close.
 */
import React, { useCallback, useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { DURATION, EASE_FORMAL } from '@/components/motion/tokens';
import { CmsImage } from '@/components/site/CmsImage';
import type { GalleryImage } from '@/lib/site-content';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------------ */
/* Lightbox                                                            */
/* ------------------------------------------------------------------ */

export function GalleryLightbox({
  images,
  index,
  onIndexChange,
  onClose
}: {
  images: GalleryImage[];
  index: number;
  onIndexChange: React.Dispatch<React.SetStateAction<number | null>>;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const image = images[index];
  const count = images.length;
  // Functional update so rapid repeated key presses each advance by one.
  const go = useCallback(
    (delta: number) => onIndexChange((current) => (((current ?? 0) + delta) % count + count) % count),
    [count, onIndexChange]
  );

  // Latest handlers for the document-level key listener (registered once).
  const handlers = useRef({ go, onClose });
  handlers.current = { go, onClose };

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handlers.current.onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handlers.current.go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlers.current.go(-1);
      } else if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  if (!image) return null;

  const navButton =
    'flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DURATION.fast, ease: EASE_FORMAL }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-5xl flex-col gap-3"
      >
        <div className="flex items-center justify-between gap-3 text-white">
          <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-slate-300" aria-live="polite">
            Image {index + 1} of {count}
          </p>
          <button ref={closeRef} type="button" onClick={onClose} className={navButton} aria-label="Close gallery viewer">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <figure className="flex min-h-0 flex-col gap-3">
          <div className="relative h-[50vh] w-full overflow-hidden rounded-xl bg-slate-900 sm:h-[68vh]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={image.id}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast, ease: EASE_FORMAL }}
              >
                <CmsImage src={image.imageUrl} alt={image.altText} sizes="(min-width: 1024px) 1024px, 100vw" className="object-contain" priority />
              </motion.div>
            </AnimatePresence>
          </div>
          <figcaption className="space-y-1 text-center text-white">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-wide">
              {image.title || image.altText}
            </h2>
            {image.caption && <p className="mx-auto max-w-3xl text-xs leading-relaxed text-slate-300">{image.caption}</p>}
            {image.category && <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#4ADE80]">{image.category}</p>}
          </figcaption>
        </figure>

        {count > 1 && (
          <div className="flex items-center justify-center gap-4">
            <button type="button" onClick={() => go(-1)} className={navButton} aria-label="Previous image">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => go(1)} className={navButton} aria-label="Next image">
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
