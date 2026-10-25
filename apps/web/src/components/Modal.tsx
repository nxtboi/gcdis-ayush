'use client';

import React, { useEffect, useId, useRef } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

interface ModalProps {
  /** Visible title; also used as the dialog's accessible name. */
  title: React.ReactNode;
  /** Optional small label rendered above the title. */
  eyebrow?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Tailwind classes for the panel (width, padding, spacing). */
  panelClassName?: string;
  /** Hide the visual header (title stays available to assistive tech). */
  hideHeader?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: role="dialog", aria-modal, aria-labelledby, Escape to close,
 * focus moved into the dialog on open, focus trapped with Tab, and restored on close.
 * Render it conditionally inside <AnimatePresence> for enter/exit animations.
 */
export function Modal({ title, eyebrow, onClose, children, panelClassName, hideHeader }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panel) {
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={`bg-white border border-slate-200 rounded-3xl w-full shadow-2xl relative focus:outline-none max-h-[90vh] overflow-y-auto ${
          panelClassName ?? 'max-w-md p-6 sm:p-8 space-y-4'
        }`}
      >
        {hideHeader ? (
          <>
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-700"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div>
              {eyebrow && (
                <span className="text-[10px] font-mono font-bold text-[#15803D] uppercase tracking-wider block">{eyebrow}</span>
              )}
              <h2 id={titleId} className="text-base font-black text-slate-900 uppercase">
                {title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="text-slate-500 hover:text-slate-700 shrink-0"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        )}
        {children}
      </motion.div>
    </motion.div>
  );
}
