'use client';

import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { buildMailto, type TeamInfo } from './types';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import { FadeIn, MotionButton, Stagger, StaggerItem, StatusDot } from './motion';

const QUERY_CATEGORIES = [
  'Drone Ball Specifications',
  'Batteries and Electrical Safety',
  'Radio Equipment and Frequencies',
  'Scoring and Match Rules',
  'Registration and Documents'
];

/** Keeps the composed mailto: link within the length that common email clients accept. */
const MAX_QUERY_LENGTH = 1500;

/**
 * Doubt Session queries. There is no doubts API yet, so the form composes an email to the
 * secretariat instead of pretending the query was stored.
 */
export default function DoubtTab({ teamInfo }: { teamInfo: TeamInfo }) {
  // Secretariat email managed from the staff console (falls back to lib/site.ts)
  const secretariatEmail = useSiteInfo().email;
  const [newDoubtCategory, setNewDoubtCategory] = useState(QUERY_CATEGORIES[0]);
  const [newDoubtSubject, setNewDoubtSubject] = useState('');
  const [newDoubtBody, setNewDoubtBody] = useState('');
  const [opened, setOpened] = useState(false);

  const handleDoubtSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const subject = newDoubtSubject.trim();
    const details = newDoubtBody.trim();
    if (!subject || !details) return;
    const body = [
      `Team: ${teamInfo.name || 'Not recorded'}`,
      `Team ID: ${teamInfo.teamCode || 'Not assigned'}`,
      `Registration: ${teamInfo.registrationCode || 'Not submitted'}`,
      `Captain: ${teamInfo.captainName || teamInfo.captainEmail}`,
      `Query category: ${newDoubtCategory}`,
      '',
      details
    ].join('\n');
    window.location.href = buildMailto(`[Doubt Session 2] ${subject}`, body, secretariatEmail);
    setOpened(true);
  };

  return (
    <Stagger className="space-y-6 max-w-5xl" stagger={0.08}>
      {/* Announcement */}
      <StaggerItem className="bg-white border border-[#86EFAC] rounded-2xl p-6 sm:p-8 space-y-2 shadow-sm">
        <span className="inline-flex items-center gap-2 text-[11px] font-bold text-[#15803D] tracking-wider uppercase font-mono">
          <StatusDot />
          Announcement
        </span>
        <h2 className="text-xl sm:text-2xl font-black text-slate-950 uppercase tracking-tight">Doubt Session 2</h2>
        <p className="text-xs text-slate-600 font-medium max-w-2xl">
          The date and time of Doubt Session 2 will be announced by the GCDIS Secretariat. Teams may submit technical queries in
          advance using the form below; queries are sent by email and answered by email.
        </p>
      </StaggerItem>

      {/* Submit Query Form */}
      <StaggerItem className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-black text-slate-900 uppercase">Submit a Technical Query</h3>

        <p className="p-3 bg-slate-50 border border-slate-200 text-slate-700 rounded-xl text-xs font-medium">
          Submitting this form opens your email application with a message addressed to{' '}
          <a href={`mailto:${secretariatEmail}`} className="font-bold text-[#15803D] hover:underline">
            {secretariatEmail}
          </a>
          , including your team details. Please send the message from your email application to complete the submission.
        </p>

        <form onSubmit={handleDoubtSubmit} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="doubt-category" className="block font-bold text-slate-700 mb-1">
                Query Category
              </label>
              <select
                id="doubt-category"
                value={newDoubtCategory}
                onChange={(e) => setNewDoubtCategory(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-slate-900 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15"
              >
                {QUERY_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="doubt-subject" className="block font-bold text-slate-700 mb-1">
                Subject or Rule Reference
              </label>
              <input
                id="doubt-subject"
                type="text"
                required
                maxLength={150}
                value={newDoubtSubject}
                onChange={(e) => setNewDoubtSubject(e.target.value)}
                placeholder="e.g. Class 40 Rulebook, Section 8"
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-slate-900 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15"
              />
            </div>
          </div>

          <div>
            <label htmlFor="doubt-body" className="block font-bold text-slate-700 mb-1">
              Query Details
            </label>
            <textarea
              id="doubt-body"
              rows={4}
              required
              maxLength={MAX_QUERY_LENGTH}
              value={newDoubtBody}
              onChange={(e) => setNewDoubtBody(e.target.value)}
              placeholder="Please state your question in full."
              aria-describedby="doubt-body-count"
              className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-slate-900 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15"
            />
            <div id="doubt-body-count" className="mt-1 text-right text-[10px] font-mono text-slate-400">
              {newDoubtBody.length} / {MAX_QUERY_LENGTH} characters
            </div>
          </div>

          <MotionButton
            type="submit"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[#15803D] hover:bg-[#166534] text-white text-xs font-black uppercase transition-colors shadow-sm"
          >
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Email Query to Secretariat</span>
          </MotionButton>

          {opened && (
            <FadeIn role="status" className="text-[11px] font-semibold text-slate-600">
              Your email application should now be open with the query prepared. If it did not open, please write to{' '}
              {secretariatEmail} directly.
            </FadeIn>
          )}
        </form>
      </StaggerItem>
    </Stagger>
  );
}
