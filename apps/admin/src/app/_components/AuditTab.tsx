'use client';

import React, { useEffect, useState } from 'react';
import { FileDown, RefreshCw } from 'lucide-react';
import Pagination from './Pagination';
import { MotionTr, SkeletonRows, LoadingAnnouncement, staggerProps } from './motion';
import { ROLE_LABELS, formatDateTime, roleLabel, type AuditLog, type PageState } from './types';

interface AuditTabProps {
  auditLogs: AuditLog[];
  isLoadingAudit: boolean;
  /** Applied filters; the text field is applied on submit rather than on every keystroke. */
  auditFilterAction: string;
  setAuditFilterAction: (value: string) => void;
  auditFilterRole: string;
  setAuditFilterRole: (value: string) => void;
  loadAuditLogs: () => void;
  onExportCsv: () => void;
  isExporting: boolean;
  pageState: PageState;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export default function AuditTab({
  auditLogs,
  isLoadingAudit,
  auditFilterAction,
  setAuditFilterAction,
  auditFilterRole,
  setAuditFilterRole,
  loadAuditLogs,
  onExportCsv,
  isExporting,
  pageState,
  onPageChange,
  onPageSizeChange
}: AuditTabProps) {
  const [actionDraft, setActionDraft] = useState(auditFilterAction);
  useEffect(() => setActionDraft(auditFilterAction), [auditFilterAction]);

  const applyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    const next = actionDraft.trim();
    if (next === auditFilterAction) loadAuditLogs();
    else setAuditFilterAction(next);
  };

  const hasFilters = Boolean(auditFilterAction || auditFilterRole);
  const showSkeleton = isLoadingAudit && auditLogs.length === 0;

  return (
    <div className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-black text-white tracking-tight">Audit Log</h2>
          <p className="text-xs text-slate-400">
            Append-only record of changes and security events. The export contains up to 5,000 entries matching the current filters.
          </p>
        </div>
        <button
          type="button"
          onClick={onExportCsv}
          disabled={isExporting}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors disabled:opacity-60"
        >
          <FileDown className="w-4 h-4" aria-hidden="true" />
          <span>{isExporting ? 'Exporting…' : 'Export CSV'}</span>
        </button>
      </div>

      {/* Filters */}
      <form onSubmit={applyFilters} className="flex flex-wrap gap-3 text-xs" role="search" aria-label="Filter the audit log">
        <label htmlFor="audit-filter-action" className="sr-only">
          Action
        </label>
        <input
          id="audit-filter-action"
          type="search"
          placeholder="Filter by action, for example LOGIN or FILE_UPLOAD"
          value={actionDraft}
          maxLength={100}
          onChange={(e) => setActionDraft(e.target.value)}
          className="bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white flex-1 min-w-[12rem] focus:outline-none focus:border-[#22C55E]"
        />
        <label htmlFor="audit-filter-role" className="sr-only">
          Role
        </label>
        <select
          id="audit-filter-role"
          value={auditFilterRole}
          onChange={(e) => setAuditFilterRole(e.target.value)}
          className="bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white"
        >
          <option value="">All Roles</option>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" className="px-4 py-2 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-bold rounded-xl transition-colors flex items-center gap-1.5">
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAudit ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          Apply
        </button>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setActionDraft('');
              setAuditFilterAction('');
              setAuditFilterRole('');
            }}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition-colors"
          >
            Clear Filters
          </button>
        )}
      </form>

      {isLoadingAudit && <LoadingAnnouncement label="Loading audit log entries." />}

      {!isLoadingAudit && auditLogs.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
          {hasFilters ? 'No audit log entries match the current filters.' : 'No audit log entries have been recorded.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-mono text-[10px] uppercase">
                <th scope="col" className="py-2.5 px-3">Date and Time</th>
                <th scope="col" className="py-2.5 px-3">Actor</th>
                <th scope="col" className="py-2.5 px-3">Role</th>
                <th scope="col" className="py-2.5 px-3">Action</th>
                <th scope="col" className="py-2.5 px-3">Record Type</th>
                <th scope="col" className="py-2.5 px-3">IP Address</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-800/60 font-mono text-[11px] transition-opacity ${isLoadingAudit && !showSkeleton ? 'opacity-60' : ''}`}>
              {showSkeleton && <SkeletonRows columns={6} rows={8} />}
              {auditLogs.map((log, index) => (
                <MotionTr key={log.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                  <td className="py-2.5 px-3 text-white break-all">{log.actorEmail || log.actorId || 'System'}</td>
                  <td className="py-2.5 px-3">
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-[#22C55E] whitespace-nowrap">
                      {roleLabel(log.actorRole)}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-bold text-white">{log.action}</td>
                  <td className="py-2.5 px-3 text-slate-300">{log.entityType || '—'}</td>
                  <td className="py-2.5 px-3 text-slate-400">{log.ipAddress || '—'}</td>
                </MotionTr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        idPrefix="audit"
        label="Audit log"
        state={pageState}
        isLoading={isLoadingAudit}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  );
}
