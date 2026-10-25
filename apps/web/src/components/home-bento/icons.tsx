import React from 'react';
import {
  Briefcase,
  Building2,
  CalendarDays,
  Eye,
  Gem,
  GraduationCap,
  Layers,
  Map,
  Monitor,
  Ruler,
  ScanLine,
  Sprout,
  Target,
  Trophy,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import type { HomeIconKey } from '@/lib/home-content';

const ICONS: Record<HomeIconKey, LucideIcon> = {
  map: Map,
  scan: ScanLine,
  wrench: Wrench,
  monitor: Monitor,
  sprout: Sprout,
  briefcase: Briefcase,
  building: Building2,
  target: Target,
  eye: Eye,
  gem: Gem,
  trophy: Trophy,
  ruler: Ruler,
  calendar: CalendarDays,
  layers: Layers,
  graduation: GraduationCap
};

/** Decorative icon for a content entry (hidden from assistive technology). */
export function HomeIcon({ name, className }: { name: HomeIconKey; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden="true" />;
}
