'use client';

import React, { useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { EASE_OUT } from './motion';

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Prevents closing (Escape, backdrop, close button) while a request is in progress. */
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZE_CLASSES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: focus moves into the dialog on open, Tab is kept inside it, Escape closes it and
 * focus returns to the control that opened it. Enters with a short fade and scale; no overshoot.
 */
export function Modal({ open, title, description, onClose, children, busy = false, size = 'md' }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const focusFirst = window.setTimeout(() => {
      const panel = panelRef.current;
      const target = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? panel)?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.clearTimeout(focusFirst);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.18 } }}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            aria-hidden="true"
            onClick={() => {
              if (!busy) onClose();
            }}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.25, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.18, ease: EASE_OUT } }}
            className={`relative w-full ${SIZE_CLASSES[size]} bg-[#111625] border border-slate-700 rounded-2xl shadow-2xl shadow-black/50 p-6 space-y-5 focus:outline-none max-h-[90vh] overflow-y-auto`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 id={titleId} className="text-base font-black text-white tracking-tight">
                  {title}
                </h2>
                {description && (
                  <p id={descriptionId} className="text-xs text-slate-400">
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                aria-label="Close dialogue"
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-40"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const BUTTON_PRIMARY =
  'px-4 py-2.5 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-bold text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const BUTTON_DANGER =
  'px-4 py-2.5 bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const BUTTON_SECONDARY =
  'px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Replaces window.confirm(): formal wording, keyboard accessible, consistent with the console. */
export function ConfirmDialog({ open, title, message, confirmLabel, tone = 'primary', busy = false, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal open={open} title={title} onClose={onCancel} busy={busy} size="sm">
      <p className="text-xs text-slate-300 leading-relaxed">{message}</p>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} disabled={busy} className={BUTTON_SECONDARY} data-autofocus>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className={tone === 'danger' ? BUTTON_DANGER : BUTTON_PRIMARY}>
          {busy ? 'Please Wait…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
