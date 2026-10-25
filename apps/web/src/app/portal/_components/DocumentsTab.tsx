'use client';

import React from 'react';
import { FileText, Eye, Download, Loader2, UploadCloud } from 'lucide-react';
import { formatDate, formatInr, type PaidInvoice, type RegistrationDocument, type TeamInfo } from './types';
import { DocumentList } from './UploadsTab';
import { FadeIn, MotionButton, Stagger, StaggerItem } from './motion';

interface DocumentsTabProps {
  teamInfo: TeamInfo;
  invoice: PaidInvoice | null;
  downloadError: string | null;
  isDownloading: boolean;
  onViewInvoice: () => void;
  onDownloadInvoice: () => void;
  documents: RegistrationDocument[];
  onGoToUploads: () => void;
}

export default function DocumentsTab({
  teamInfo,
  invoice,
  downloadError,
  isDownloading,
  onViewInvoice,
  onDownloadInvoice,
  documents,
  onGoToUploads
}: DocumentsTabProps) {
  return (
    <Stagger className="space-y-6 max-w-5xl" stagger={0.08}>
      <StaggerItem className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-black text-slate-900 uppercase">Submitted Documents</h2>
            <p className="text-xs text-slate-500 font-medium">Documents linked to your registration and their review status.</p>
          </div>
          <MotionButton
            type="button"
            onClick={onGoToUploads}
            className="self-start inline-flex items-center gap-2 px-4 py-2 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-bold uppercase transition-colors"
          >
            <UploadCloud className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Upload Documents</span>
          </MotionButton>
        </div>
        <DocumentList documents={documents} />
      </StaggerItem>

      <StaggerItem className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-[#DCFCE7] text-[#15803D] flex items-center justify-center">
              <FileText className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900 uppercase">Registration Invoices</h2>
              <p className="text-xs text-slate-500 font-medium">View and download the tax invoice for your registration fee.</p>
            </div>
          </div>

          <span className="bg-slate-100 text-slate-600 border border-slate-200 text-xs font-bold px-3 py-1 rounded-full">
            {invoice ? '1 INVOICE' : 'NO INVOICES'}
          </span>
        </div>

        {/* Invoice Card or Empty State */}
        {invoice ? (
          <div className="bg-white border border-slate-200/90 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm transition-colors duration-200 hover:border-[#86EFAC]">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#DCFCE7] text-[#15803D] flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-black text-slate-900 uppercase font-mono break-all">INV-{invoice.orderId}</div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Registration Invoice</div>
                <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                  {teamInfo.registrationCode ? `Registration ${teamInfo.registrationCode} • ` : ''}
                  {formatInr(invoice.amount)} paid on {formatDate(invoice.paidAt)}
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              <MotionButton
                type="button"
                onClick={onViewInvoice}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-bold uppercase transition-colors"
              >
                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                <span>View</span>
              </MotionButton>

              <MotionButton
                type="button"
                onClick={onDownloadInvoice}
                disabled={isDownloading}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#15803D] hover:bg-[#166534] disabled:opacity-60 disabled:cursor-wait text-white text-xs font-black uppercase transition-colors shadow-sm"
              >
                {isDownloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{isDownloading ? 'Preparing…' : 'Download'}</span>
              </MotionButton>
            </div>
          </div>
        ) : (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-8 text-center space-y-2">
            <FileText className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
            <div className="text-sm font-bold text-slate-800">No Invoices Available</div>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              A tax invoice is generated automatically once your registration fee payment has been verified.
            </p>
          </div>
        )}
        {downloadError && (
          <FadeIn role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
            {downloadError}
          </FadeIn>
        )}
      </StaggerItem>
    </Stagger>
  );
}
