'use client';

import React from 'react';
import { PAGE_SIZE_OPTIONS, type PageState } from './types';

interface PaginationProps {
  /** Used to build unique element ids and accessible labels, e.g. "registrations". */
  idPrefix: string;
  label: string;
  state: PageState;
  isLoading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

/** Total number of pages, or null when the API does not report a total. */
export function totalPages(state: PageState): number | null {
  if (state.total === null) return null;
  return Math.max(1, Math.ceil(state.total / state.pageSize));
}

export function hasNextPage(state: PageState): boolean {
  const pages = totalPages(state);
  if (pages !== null) return state.page < pages;
  // Without a total, a full page means there may be more records
  return state.count >= state.pageSize;
}

export default function Pagination({ idPrefix, label, state, isLoading, onPageChange, onPageSizeChange }: PaginationProps) {
  const pages = totalPages(state);
  const firstRow = state.count === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const lastRow = (state.page - 1) * state.pageSize + state.count;
  const buttonClass =
    'px-3 py-1.5 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <nav aria-label={`${label} pages`} className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-slate-400">
      <div aria-live="polite">
        {pages !== null ? (
          <span>
            Page {state.page} of {pages}
            {state.total !== null && state.count > 0 && (
              <>
                {' '}
                (entries {firstRow}–{lastRow} of {state.total})
              </>
            )}
          </span>
        ) : (
          <span>
            Page {state.page}
            {state.count > 0 && (
              <>
                {' '}
                (entries {firstRow}–{lastRow})
              </>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${idPrefix}-page-size`} className="text-slate-400">
          Rows per page
        </label>
        <select
          id={`${idPrefix}-page-size`}
          value={state.pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="bg-[#182035] border border-slate-700 rounded-lg px-2 py-1.5 text-white"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={buttonClass}
          disabled={isLoading || state.page <= 1}
          onClick={() => onPageChange(state.page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={isLoading || !hasNextPage(state)}
          onClick={() => onPageChange(state.page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
