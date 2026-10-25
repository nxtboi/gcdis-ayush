'use client';

import React from 'react';
import { AnimatePresence, MotionConfig, motion, type Variants } from 'framer-motion';
import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

/**
 * Motion vocabulary for the staff console: short (0.18 to 0.35 s), eased deceleration, no springs or
 * overshoot. MotionConfig reducedMotion="user" removes transform animation when the operating system
 * requests reduced motion; opacity fades remain so state changes are still perceptible.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.25, ease: EASE_OUT }}>
      {children}
    </MotionConfig>
  );
}

/** Tab content: rises slightly into place, fades out quickly when the tab changes. */
export const panelVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15, ease: EASE_OUT } }
};

/** Largest stagger index: long tables do not keep animating after the first screen of rows. */
const MAX_STAGGER_INDEX = 12;

/** Table rows and cards: staggered fade and rise, keyed by the row index passed as `custom`. */
export const itemVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: EASE_OUT, delay: Math.min(index, MAX_STAGGER_INDEX) * 0.03 }
  })
};

/** Props that stagger a list item into view. */
export function staggerProps(index: number) {
  return { variants: itemVariants, initial: 'initial', animate: 'animate', custom: index } as const;
}

export const MotionTr = motion.tr;
export const MotionDiv = motion.div;
export const MotionLi = motion.li;

/** Keyed tab panel; wrap a set of panels in <AnimatePresence mode="wait">. */
export function TabPanel({ panelKey, children, className }: { panelKey: string; children: React.ReactNode; className?: string }) {
  return (
    <motion.div key={panelKey} variants={panelVariants} initial="initial" animate="animate" exit="exit" className={className}>
      {children}
    </motion.div>
  );
}

type NoticeTone = 'success' | 'error' | 'info' | 'warning';

const NOTICE_STYLES: Record<NoticeTone, string> = {
  success: 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300',
  error: 'bg-rose-500/10 border-rose-500/40 text-rose-300',
  info: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
  warning: 'bg-amber-500/10 border-amber-500/40 text-amber-300'
};

const NOTICE_ICONS: Record<NoticeTone, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  success: CheckCircle,
  error: AlertTriangle,
  info: Info,
  warning: AlertTriangle
};

interface NoticeProps {
  tone: NoticeTone;
  message: string | null | undefined;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Inline notice with enter and exit transitions. The live region stays mounted so screen readers
 * announce each new message: errors use role="alert", everything else role="status".
 */
export function Notice({ tone, message, onDismiss, className = '' }: NoticeProps) {
  const Icon = NOTICE_ICONS[tone];
  const live = tone === 'error' ? { role: 'alert' as const } : { role: 'status' as const, 'aria-live': 'polite' as const };
  return (
    <div {...live} className={className}>
      <AnimatePresence initial={false}>
        {message && (
          <motion.div
            key={message}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className={`p-4 border text-xs rounded-xl flex items-start justify-between gap-3 ${NOTICE_STYLES[tone]}`}
          >
            <div className="flex items-start gap-2">
              <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden={true} />
              <span>{message}</span>
            </div>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss message"
                className="opacity-80 hover:opacity-100 transition-opacity"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Loading placeholder block with a slow shimmer (static when reduced motion is requested). */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`admin-skeleton rounded-md ${className}`} />;
}

/** Placeholder table rows shown while a table loads; sized like real rows to avoid layout shift. */
export function SkeletonRows({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: columns }, (_, col) => (
            <td key={col} className="py-3 px-3">
              <Skeleton className={`h-3.5 ${col === 0 ? 'w-24' : col === columns - 1 ? 'w-16 ml-auto' : 'w-32'}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Screen-reader announcement for a loading region. */
export function LoadingAnnouncement({ label }: { label: string }) {
  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  );
}
