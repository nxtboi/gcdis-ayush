'use client';

import React, { useState } from 'react';
import RegistrationDetailDialog from './RegistrationDetailDialog';
import { canViewDocuments } from './documentReview';
import { MotionTr, Notice, SkeletonRows, staggerProps } from './motion';
import {
  FAILSAFE_MAX_SECONDS,
  FIDA_BALL_LIMITS,
  fidaClassOf,
  formatDateTime,
  statusLabel,
  type AdminRegistration,
  type InspectionRecord
} from './types';

interface ScrutineeringTabProps {
  /** Registrations at TECHNICAL_INSPECTION: the only ones the API accepts for inspection. */
  registrations: AdminRegistration[];
  inspections: InspectionRecord[];
  isLoadingInspections: boolean;
  inspResult: { passed: boolean; message: string } | null;
  onDismissResult: () => void;
  inspRegistrationId: string;
  setInspRegistrationId: (value: string) => void;
  inspDiameter: number;
  setInspDiameter: (value: number) => void;
  inspWeight: number;
  setInspWeight: (value: number) => void;
  inspLatency: number;
  setInspLatency: (value: number) => void;
  inspNotes: string;
  setInspNotes: (value: string) => void;
  isSubmitting: boolean;
  handleSubmitScrutineering: (e: React.FormEvent) => void;
  /** Signed-in staff role: inspectors may view a team's documents (read only) before inspecting. */
  role?: string | null;
}

const INPUT = 'w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#22C55E]';

export default function ScrutineeringTab({
  registrations,
  inspections,
  isLoadingInspections,
  inspResult,
  onDismissResult,
  inspRegistrationId,
  setInspRegistrationId,
  inspDiameter,
  setInspDiameter,
  inspWeight,
  setInspWeight,
  inspLatency,
  setInspLatency,
  inspNotes,
  setInspNotes,
  isSubmitting,
  handleSubmitScrutineering,
  role
}: ScrutineeringTabProps) {
  const [documentsFor, setDocumentsFor] = useState<string | null>(null);
  const selected = registrations.find((r) => r.id === inspRegistrationId);
  const limits = FIDA_BALL_LIMITS[fidaClassOf(selected?.category?.name)];
  const diameterOk = inspDiameter >= limits.minDiameterMm && inspDiameter <= limits.maxDiameterMm;
  const weightOk = inspWeight > 0 && inspWeight <= limits.maxWeightGrams;
  const failsafeOk = inspLatency >= 0 && inspLatency < FAILSAFE_MAX_SECONDS;
  const hint = (ok: boolean) => (ok ? 'text-slate-400' : 'text-amber-400');

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
      <RegistrationDetailDialog registrationId={documentsFor} role={role} onClose={() => setDocumentsFor(null)} />
      <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-6" aria-labelledby="inspection-heading">
        <div className="space-y-1">
          <h2 id="inspection-heading" className="text-base font-black text-white tracking-tight">
            Record a Technical Inspection
          </h2>
          <p className="text-xs text-slate-400">
            Drone ball limits under the FIDA Dronesoccer Regulations (5th Revision, 1 October 2025): Class 20, diameter 20 cm &plusmn; 1 cm
            (190&ndash;210 mm) and weight not exceeding 110 g; Class 40, diameter 40 cm &plusmn; 2 cm (380&ndash;420 mm) and weight not
            exceeding 1,100 g. The failsafe response check is a GCDIS organiser safety requirement and is not part of the FIDA
            regulations.
          </p>
        </div>

        <Notice tone={inspResult?.passed ? 'success' : 'error'} message={inspResult?.message} onDismiss={onDismissResult} />

        <form onSubmit={handleSubmitScrutineering} className="space-y-4 text-xs">
          <div>
            <label htmlFor="insp-registration" className="block font-bold text-slate-300 mb-1">
              Registered Team
            </label>
            <select
              id="insp-registration"
              value={inspRegistrationId}
              onChange={(e) => setInspRegistrationId(e.target.value)}
              required
              className={INPUT}
            >
              <option value="">{registrations.length ? 'Select a registration' : 'No registrations are awaiting inspection'}</option>
              {registrations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.team?.name || 'Team name not provided'} ({r.registrationCode || r.id.slice(0, 8)})
                </option>
              ))}
            </select>
            {selected && canViewDocuments(role) && (
              <button
                type="button"
                onClick={() => setDocumentsFor(selected.id)}
                className="mt-2 px-2.5 py-1 bg-[#182035] hover:bg-slate-800 border border-slate-700 text-slate-200 rounded text-[10px] font-bold transition-colors"
              >
                View Team Documents
              </button>
            )}
            <p className="text-[10px] text-slate-400 mt-1">
              Only registrations with the status Technical Inspection are listed. Use the Registrations section to move a registration to
              this status. Limits shown apply to {limits.label}.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="insp-diameter" className="block font-bold text-slate-300 mb-1">
                Diameter (mm)
              </label>
              <input
                id="insp-diameter"
                type="number"
                min={0}
                step="1"
                required
                value={Number.isFinite(inspDiameter) ? inspDiameter : ''}
                onChange={(e) => setInspDiameter(e.target.valueAsNumber)}
                className={`${INPUT} font-mono`}
              />
              <span className={`text-[10px] ${hint(diameterOk)}`}>
                Permitted: {limits.minDiameterMm}&ndash;{limits.maxDiameterMm} mm (FIDA)
              </span>
            </div>

            <div>
              <label htmlFor="insp-weight" className="block font-bold text-slate-300 mb-1">
                Weight (g)
              </label>
              <input
                id="insp-weight"
                type="number"
                min={0}
                step="1"
                required
                value={Number.isFinite(inspWeight) ? inspWeight : ''}
                onChange={(e) => setInspWeight(e.target.valueAsNumber)}
                className={`${INPUT} font-mono`}
              />
              <span className={`text-[10px] ${hint(weightOk)}`}>
                Permitted: up to {limits.maxWeightGrams.toLocaleString('en-IN')} g (FIDA)
              </span>
            </div>

            <div>
              <label htmlFor="insp-latency" className="block font-bold text-slate-300 mb-1">
                Failsafe Response (s)
              </label>
              <input
                id="insp-latency"
                type="number"
                min={0}
                step="0.01"
                required
                value={Number.isFinite(inspLatency) ? inspLatency : ''}
                onChange={(e) => setInspLatency(e.target.valueAsNumber)}
                className={`${INPUT} font-mono`}
              />
              <span className={`text-[10px] ${hint(failsafeOk)}`}>
                Permitted: under {FAILSAFE_MAX_SECONDS.toFixed(2)} s (GCDIS)
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="insp-notes" className="block font-bold text-slate-300 mb-1">
              Inspection Notes (optional)
            </label>
            <input
              id="insp-notes"
              type="text"
              maxLength={500}
              value={inspNotes}
              onChange={(e) => setInspNotes(e.target.value)}
              placeholder="For example: protective frame intact; team lights and striker marking fitted"
              className={INPUT}
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !inspRegistrationId}
            className="px-6 py-3 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-black rounded-xl text-xs shadow-md shadow-[#22C55E]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Recording…' : 'Record Inspection'}
          </button>
        </form>
      </section>

      <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="inspection-history-heading">
        <div>
          <h2 id="inspection-history-heading" className="text-base font-black text-white tracking-tight">
            Recent Inspections
          </h2>
          <p className="text-xs text-slate-400">The 50 most recent inspection records, newest first.</p>
        </div>
        {!isLoadingInspections && inspections.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
            No inspections have been recorded.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase">
                  <th scope="col" className="py-2.5 px-3">Recorded</th>
                  <th scope="col" className="py-2.5 px-3">Team</th>
                  <th scope="col" className="py-2.5 px-3">Measurements</th>
                  <th scope="col" className="py-2.5 px-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-[11px]">
                {isLoadingInspections && inspections.length === 0 && <SkeletonRows columns={4} rows={4} />}
                {inspections.map((insp, index) => (
                  <MotionTr key={insp.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{formatDateTime(insp.inspectedAt)}</td>
                    <td className="py-2.5 px-3 text-white">
                      {insp.registration?.team?.name || 'Team name not provided'}
                      <span className="block text-[10px] text-slate-400">{insp.registration?.registrationCode}</span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                      {insp.diameterMm ?? 0} mm, {insp.weightGrams ?? 0} g, {insp.failsafeLatencySec ?? 0} s
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] ${
                          insp.status === 'PASSED'
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                        }`}
                      >
                        {statusLabel(insp.status)}
                      </span>
                    </td>
                  </MotionTr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
