'use client';

import React, { useState } from 'react';
import { Modal, BUTTON_PRIMARY, BUTTON_SECONDARY } from './Modal';
import { MotionTr, Notice, staggerProps } from './motion';
import { formatInr, type Prize, type PrizePool } from './types';

export interface PrizeUpdate {
  title: string;
  amount: number;
  isConfirmed: boolean;
  notes: string | null;
}

interface PrizesTabProps {
  prizePool: PrizePool;
  canEdit: boolean;
  /** Resolves when the API accepts the update; rejects with a formal message otherwise. */
  onSavePrize: (id: string, update: PrizeUpdate) => Promise<void>;
}

const FIELD = 'w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#22C55E]';
const MAX_AMOUNT = 100_000_000;

export default function PrizesTab({ prizePool, canEdit, onSavePrize }: PrizesTabProps) {
  const [editing, setEditing] = useState<Prize | null>(null);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (prize: Prize) => {
    setEditing(prize);
    setTitle(prize.title ?? '');
    setAmount(String(prize.amount ?? 0));
    setIsConfirmed(Boolean(prize.isConfirmed));
    setNotes(prize.notes ?? '');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 0 || value > MAX_AMOUNT) {
      setError('Please enter the amount as a whole number of rupees between 0 and 10,00,00,000.');
      return;
    }
    if (!title.trim()) {
      setError('Please enter a title for the prize.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSavePrize(editing.id, { title: title.trim(), amount: value, isConfirmed, notes: notes.trim() || null });
      setNotice(`The prize "${title.trim()}" has been updated.`);
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The prize could not be updated.');
    } finally {
      setIsSaving(false);
    }
  };

  const prizes = prizePool.prizes ?? [];

  return (
    <div className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4 max-w-5xl">
      <div>
        <h2 className="text-base font-black text-white tracking-tight">Prizes and Unallocated Balance</h2>
        <p className="text-xs text-slate-400">
          Prize pool of {formatInr(prizePool.poolTotal)}: {formatInr(prizePool.confirmedTotal)} confirmed and{' '}
          {formatInr(prizePool.unallocated)} unallocated ({prizePool.unallocatedStatus || 'status not reported'}). Only confirmed prizes count
          towards the allocated total.
        </p>
      </div>

      <Notice tone="success" message={notice} onDismiss={() => setNotice(null)} />

      {prizes.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
          No prizes have been defined.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase">
                <th scope="col" className="py-2.5 px-3">Category</th>
                <th scope="col" className="py-2.5 px-3">Prize</th>
                <th scope="col" className="py-2.5 px-3 text-right">Amount</th>
                <th scope="col" className="py-2.5 px-3">Status</th>
                {canEdit && (
                  <th scope="col" className="py-2.5 px-3 text-right">
                    Action
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-[11px]">
              {prizes.map((p, index) => (
                <MotionTr key={p.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2.5 px-3 font-bold text-white">{p.category}</td>
                  <td className="py-2.5 px-3 text-slate-300">{p.title || `Rank ${p.rank}`}</td>
                  <td className="py-2.5 px-3 text-[#22C55E] text-right whitespace-nowrap">{formatInr(p.amount)}</td>
                  <td className={`py-2.5 px-3 ${p.isConfirmed ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {p.isConfirmed ? 'Confirmed' : 'Pending'}
                  </td>
                  {canEdit && (
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => open(p)}
                        aria-label={`Edit the prize ${p.title || p.id}`}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-bold transition-colors"
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </MotionTr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editing !== null}
        title="Edit Prize"
        description={editing ? `Category ${editing.category}. Changes are recorded in the audit log.` : undefined}
        onClose={() => !isSaving && setEditing(null)}
        busy={isSaving}
      >
        <form onSubmit={submit} className="space-y-4 text-xs">
          <Notice tone="error" message={error} />
          <div>
            <label htmlFor="prize-title" className="block font-bold text-slate-300 mb-1">
              Title
            </label>
            <input id="prize-title" type="text" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} data-autofocus />
          </div>
          <div>
            <label htmlFor="prize-amount" className="block font-bold text-slate-300 mb-1">
              Amount (INR)
            </label>
            <input
              id="prize-amount"
              type="number"
              required
              min={0}
              max={MAX_AMOUNT}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={`${FIELD} font-mono`}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="prize-confirmed"
              type="checkbox"
              checked={isConfirmed}
              onChange={(e) => setIsConfirmed(e.target.checked)}
              className="w-4 h-4 accent-[#22C55E]"
            />
            <label htmlFor="prize-confirmed" className="text-slate-300 font-bold">
              Confirmed by the organising committee
            </label>
          </div>
          <div>
            <label htmlFor="prize-notes" className="block font-bold text-slate-300 mb-1">
              Notes (optional)
            </label>
            <textarea id="prize-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={FIELD} />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setEditing(null)} disabled={isSaving} className={BUTTON_SECONDARY}>
              Cancel
            </button>
            <button type="submit" disabled={isSaving} className={BUTTON_PRIMARY}>
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
