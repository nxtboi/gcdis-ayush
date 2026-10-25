'use client';

import React from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { statusLabel, type TeamInfo } from './types';
import { motion } from 'framer-motion';
import { buttonPress, Stagger, StaggerItem } from './motion';

const FIDA_NAME = 'Federation of International Dronesoccer Association (FIDA)';

const CLASS_SPECS = [
  {
    id: '20',
    title: 'Class 20 (D20)',
    rulebook: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
    points: [
      'Drone ball diameter: 20 cm ± 1 cm',
      'Maximum weight in play: 110 g',
      'Strikers per team: 2',
      'Goal inner diameter: 30 cm',
      'Open area of any single exoskeleton surface: not more than 70 cm²'
    ]
  },
  {
    id: '40',
    title: 'Class 40 (D40)',
    rulebook: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
    points: [
      'Drone ball diameter: 40 cm ± 2 cm',
      'Maximum weight in play: 1,100 g',
      'Strikers per team: 1',
      'Goal inner diameter: 60 cm',
      'Open area of any single exoskeleton surface: not more than 150 cm²'
    ]
  }
] as const;

const GENERAL_RULES = [
  'Match format: 3 sets of 3 minutes each, with repair time between sets.',
  'Team roster: at most 7 members, including the captain, of whom no more than 3 may be coaches.',
  'Each drone is fully enclosed in a rounded protective exoskeleton and carries red or blue team lighting; Strikers carry an identification tag.',
  'A goal is scored only when a Striker passes completely through the opposing goal from front to back.',
  'Radio equipment must comply with the applicable laws of India and must not interfere with other teams.'
];

/** Detects the team's class from the category name (e.g. "Class 20 (D20) Drone Soccer"). */
function teamClass(category: string): '20' | '40' | null {
  if (/\b(class\s*20|d20)\b/i.test(category)) return '20';
  if (/\b(class\s*40|d40)\b/i.test(category)) return '40';
  return null;
}

export default function MissionTab({ teamInfo }: { teamInfo: TeamInfo }) {
  const ownClass = teamClass(teamInfo.category);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="text-[11px] font-mono font-bold text-[#15803D] uppercase tracking-wider block">
              Competition Category
            </span>
            <h2 className="text-2xl font-black text-slate-950 uppercase tracking-tight break-words">
              {teamInfo.category || 'Category not yet selected'}
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Matches are conducted under the current regulations of the {FIDA_NAME}. The official rulebook for your class takes
              precedence over this summary.
            </p>
          </div>

          <span className="self-start shrink-0 px-3 py-1 bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-xs font-mono font-bold rounded-full uppercase">
            {statusLabel(teamInfo.status)}
          </span>
        </div>

        <Stagger className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs" stagger={0.07}>
          {CLASS_SPECS.map((spec) => {
            const own = ownClass === spec.id;
            return (
              <StaggerItem
                key={spec.id}
                className={`p-4 rounded-xl border space-y-2 transition-colors ${
                  own ? 'bg-[#DCFCE7]/40 border-[#86EFAC]' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-bold text-slate-900">{spec.title}: Drone Ball Specifications</h3>
                  {own && (
                    <span className="shrink-0 rounded-full bg-[#15803D] px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                      Your class
                    </span>
                  )}
                </div>
                <ul className="space-y-1 text-slate-600 text-[11px] list-disc list-inside">
                  {spec.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </StaggerItem>
            );
          })}

          <StaggerItem className="md:col-span-2 bg-slate-50 border border-slate-200 p-4 rounded-xl space-y-2">
            <h3 className="font-bold text-slate-900">Match and Team Regulations (Both Classes)</h3>
            <ul className="space-y-1 text-slate-600 text-[11px] list-disc list-inside">
              {GENERAL_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </StaggerItem>
        </Stagger>

        <div className="pt-2 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
          {CLASS_SPECS.map((spec) => (
            <motion.a
              key={spec.id}
              href={spec.rulebook}
              target="_blank"
              rel="noopener noreferrer"
              whileTap={buttonPress}
              className={`flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-white text-xs font-black uppercase transition-colors ${
                spec.id === '20' ? 'bg-[#15803D] hover:bg-[#166534]' : 'bg-[#111625] hover:bg-slate-800'
              }`}
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>FIDA {spec.title} Rulebook (PDF)</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-70" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </motion.a>
          ))}
        </div>
      </div>
    </div>
  );
}
