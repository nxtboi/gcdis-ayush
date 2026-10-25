'use client';

import React from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { formatDate, formatInr, type PaidInvoice, type TeamInfo } from './types';
import { FadeIn, MotionButton } from './motion';

interface InvoiceModalProps {
  teamInfo: TeamInfo;
  invoice: PaidInvoice;
  onClose: () => void;
  onDownload: () => void;
  downloadError: string | null;
  isDownloading: boolean;
}

/** Invoice summary built from the real payment record; the official tax invoice is the server-generated PDF. */
export default function InvoiceModal({
  teamInfo,
  invoice,
  onClose,
  onDownload,
  downloadError,
  isDownloading
}: InvoiceModalProps) {
  const gstRate = invoice.gstRate ?? null;

  return (
    <Modal
      title={`Invoice INV-${invoice.orderId}`}
      eyebrow="Registration invoice summary"
      onClose={onClose}
      panelClassName="max-w-lg p-6 sm:p-8 space-y-5"
    >
      <div className="text-xs space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase">Billed To</span>
            <div className="font-bold text-slate-900">{teamInfo.name ? `Team ${teamInfo.name}` : 'Team name not recorded'}</div>
            <div className="text-slate-600">{teamInfo.institute || 'Institution not specified'}</div>
            <div className="text-slate-600">Captain: {teamInfo.captainName || 'Not specified'}</div>
          </div>
          <div className="sm:text-right">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Issued By</span>
            <div className="font-bold text-slate-900">GCDIS Secretariat, Galgotias University</div>
            <div className="text-slate-600">Full billing details appear on the PDF invoice.</div>
          </div>
        </div>

        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 font-bold text-slate-700 border-b border-slate-200">
              <tr>
                <th scope="col" className="p-3">
                  Item Description
                </th>
                <th scope="col" className="p-3 text-right">
                  Amount ({invoice.currency})
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr>
                <td className="p-3">
                  <div className="font-bold text-slate-900">Drone Soccer Championship 2026: Registration Fee</div>
                  <div className="text-[10px] text-slate-500">Category: {teamInfo.category || '—'}</div>
                </td>
                <td className="p-3 text-right font-mono font-bold">{formatInr(invoice.baseAmount ?? null)}</td>
              </tr>
              <tr>
                <td className="p-3 text-slate-600">GST{gstRate !== null ? ` (${gstRate}%)` : ''}</td>
                <td className="p-3 text-right font-mono">{formatInr(invoice.gstAmount ?? null)}</td>
              </tr>
              <tr className="bg-emerald-50/50 font-bold text-slate-900">
                <td className="p-3">Total Amount Paid</td>
                <td className="p-3 text-right font-mono text-[#15803D] text-sm font-black">{formatInr(invoice.amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
          <div>
            PAYMENT STATUS: <strong className="text-[#15803D]">RECEIVED</strong>
          </div>
          <div>Paid on {formatDate(invoice.paidAt)}</div>
        </div>

        {downloadError && (
          <FadeIn role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
            {downloadError}
          </FadeIn>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-full border border-slate-300 text-slate-700 font-bold text-xs transition-colors hover:bg-slate-50"
        >
          Close
        </button>
        <MotionButton
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          className="px-5 py-2 rounded-full bg-[#15803D] hover:bg-[#166534] disabled:opacity-60 disabled:cursor-wait text-white font-black text-xs uppercase flex items-center gap-1.5 shadow-sm transition-colors"
        >
          {isDownloading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>{isDownloading ? 'Preparing PDF…' : 'Download PDF Invoice'}</span>
        </MotionButton>
      </div>
    </Modal>
  );
}
