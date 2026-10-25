'use client';

import Image from 'next/image';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { ChevronsLeft, ChevronsRight, Loader2, LogOut, MonitorSmartphone, X } from 'lucide-react';
import { useFocusTrap } from './useFocusTrap';

/**
 * Staff console navigation in the "bold bento" style of the public home page, adapted to the console's
 * dark scheme: heavy uppercase group headings, a lime active pill with a hard offset shadow that glides
 * between items, count badges, a collapse-to-icons mode (remembered per browser) with tooltips, and a
 * signed-in user card. Below 1024 px the same content opens as an off-canvas drawer with a focus trap.
 */

export interface SidebarItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Count badges for the item (rendered after the label, or on the icon corner when collapsed). */
  badge?: (isActive: boolean) => React.ReactNode;
}

export interface SidebarGroup<T extends string> {
  id: string;
  label: string;
  items: SidebarItem<T>[];
}

interface AdminSidebarProps<T extends string> {
  groups: SidebarGroup<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  user: { name: string; email: string; role: string };
  onSignOut: () => Promise<void> | void;
  onSignOutAll: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

const COLLAPSE_KEY = 'gcdis.admin.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    // Storage unavailable (private mode, blocked site data): the choice lasts for this visit only
  }
}

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bento-lime';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

interface PanelProps<T extends string> extends Omit<AdminSidebarProps<T>, 'mobileOpen' | 'onMobileClose'> {
  variant: 'desktop' | 'drawer';
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onClose?: () => void;
}

function SidebarPanel<T extends string>({
  variant,
  groups,
  activeId,
  onSelect,
  user,
  onSignOut,
  onSignOutAll,
  collapsed,
  onToggleCollapsed,
  onClose
}: PanelProps<T>) {
  const [tooltip, setTooltip] = useState<{ label: string; top: number } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const tooltipId = useId();

  const showTip = (label: string, el: HTMLElement) => {
    if (!collapsed) return;
    const rect = el.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2 });
  };
  const hideTip = () => setTooltip(null);
  useEffect(() => {
    if (!collapsed) setTooltip(null);
  }, [collapsed]);

  const tipProps = (label: string) =>
    collapsed
      ? {
          onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showTip(label, e.currentTarget),
          onMouseLeave: hideTip,
          onFocus: (e: React.FocusEvent<HTMLElement>) => showTip(label, e.currentTarget),
          onBlur: hideTip,
          'aria-describedby': tooltip?.label === label ? tooltipId : undefined
        }
      : {};

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div
        className={`flex items-center gap-2.5 border-b border-slate-800/80 py-4 ${
          collapsed ? 'justify-center px-2' : 'justify-between px-5'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Image src="/gcdis-logo.png" alt="GCDIS" width={40} height={40} className="shrink-0 rounded-full bg-white ring-2 ring-bento-lime/70" />
          {!collapsed && (
            <div className="min-w-0">
              <span className="block text-base font-black uppercase leading-none tracking-[-0.02em] text-white">GCDIS</span>
              <span className="mt-1 inline-block rounded bg-bento-lime px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-slate-950">
                Staff Console
              </span>
            </div>
          )}
        </div>
        {variant === 'drawer' && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className={`flex h-11 w-11 items-center justify-center rounded-xl border-2 border-slate-700 text-slate-300 transition-colors hover:border-bento-lime hover:text-bento-lime ${FOCUS_RING}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav
        className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-3 ${collapsed ? 'px-2' : 'px-3'}`}
        aria-label="Console sections"
        onScroll={hideTip}
      >
        <LayoutGroup id={`admin-nav-${variant}`}>
          {groups.map((group) => (
            <div key={group.id} className="mb-3 last:mb-0" role="group" aria-labelledby={`${variant}-nav-group-${group.id}`}>
              <h2
                id={`${variant}-nav-group-${group.id}`}
                className={
                  collapsed
                    ? 'sr-only'
                    : 'mb-1.5 flex items-center gap-2 px-3 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400'
                }
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bento-lime" />
                {group.label}
              </h2>
              {collapsed && <div aria-hidden="true" className="mx-auto mb-2 h-px w-8 bg-slate-800" />}
              <ul className="space-y-0.5">
                {group.items.map(({ id, label, icon: Icon, badge }) => {
                  const isActive = activeId === id;
                  const badges = badge?.(isActive);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={collapsed ? label : undefined}
                        {...tipProps(label)}
                        className={`group relative flex w-full items-center rounded-xl text-left text-xs font-bold transition-colors duration-200 ${FOCUS_RING} ${
                          collapsed ? 'h-10 justify-center px-0' : 'min-h-[38px] gap-3 px-3 py-2'
                        } ${isActive ? 'text-slate-950' : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'}`}
                      >
                        {isActive && (
                          <motion.span
                            layoutId="active-pill"
                            aria-hidden="true"
                            className="absolute inset-0 rounded-xl border-2 border-slate-950 bg-bento-lime shadow-[3px_3px_0_#000]"
                            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                          />
                        )}
                        <Icon
                          className={`relative z-10 h-4 w-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${
                            isActive ? '' : 'group-hover:scale-110 motion-reduce:group-hover:scale-100'
                          }`}
                        />
                        {!collapsed && <span className="relative z-10 min-w-0 flex-1 truncate">{label}</span>}
                        {badges && (
                          <span
                            className={
                              collapsed
                                ? 'absolute -right-1 -top-1 z-10 flex flex-col items-end gap-0.5'
                                : 'relative z-10 ml-auto flex shrink-0 items-center gap-1'
                            }
                          >
                            {badges}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </LayoutGroup>
      </nav>

      {/* Collapse toggle (desktop only) */}
      {variant === 'desktop' && onToggleCollapsed && (
        <div className={`border-t border-slate-800/80 py-2 ${collapsed ? 'px-2' : 'px-3'}`}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            {...tipProps('Expand sidebar')}
            className={`flex h-10 w-full items-center gap-3 rounded-xl text-[11px] font-bold uppercase tracking-wider text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white ${FOCUS_RING} ${
              collapsed ? 'justify-center' : 'px-3'
            }`}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" aria-hidden="true" /> : <ChevronsLeft className="h-4 w-4" aria-hidden="true" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      )}

      {/* Signed-in user card */}
      <div className={`border-t border-slate-800/80 ${collapsed ? 'p-2' : 'p-3'}`}>
        <div
          className={`rounded-2xl border-2 border-slate-700 bg-[#0B0F19] ${collapsed ? 'flex flex-col items-center gap-1.5 p-1.5' : 'p-3'}`}
        >
          <div className={`flex items-center gap-2.5 ${collapsed ? 'justify-center' : ''}`} {...tipProps(`${user.name} (${user.role})`)}>
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border-2 border-slate-950 bg-bento-lime font-mono text-xs font-black text-slate-950 shadow-[2px_2px_0_#000]"
            >
              {initials(user.name)}
            </span>
            {collapsed ? (
              <span className="sr-only">
                Signed in as {user.name}, {user.role}
              </span>
            ) : (
              <div className="min-w-0">
                <p className="truncate text-xs font-black text-white" title={user.email}>
                  <span className="sr-only">Signed in as </span>
                  {user.name}
                </p>
                <p className="truncate font-mono text-[10px] font-bold uppercase tracking-wider text-bento-lime">{user.role}</p>
              </div>
            )}
          </div>
          <div className={collapsed ? 'flex flex-col gap-1' : 'mt-3 grid grid-cols-2 gap-2'}>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label={collapsed ? 'Sign Out' : undefined}
              title={collapsed ? undefined : 'Sign out of this device'}
              {...tipProps('Sign Out')}
              className={`flex items-center justify-center gap-1.5 rounded-lg text-[11px] font-bold text-rose-300 transition-colors hover:bg-rose-500/15 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 ${FOCUS_RING} ${
                collapsed ? 'h-9 w-9' : 'min-h-[36px] whitespace-nowrap border border-rose-500/30 px-2'
              }`}
            >
              {signingOut ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {!collapsed && <span>Sign Out</span>}
            </button>
            <button
              type="button"
              onClick={onSignOutAll}
              aria-label={collapsed ? 'Sign Out of All Sessions' : undefined}
              title={collapsed ? undefined : 'Sign Out of All Sessions'}
              {...tipProps('Sign Out of All Sessions')}
              className={`flex items-center justify-center gap-1.5 rounded-lg text-[11px] font-bold text-slate-300 transition-colors hover:bg-rose-500/10 hover:text-rose-300 ${FOCUS_RING} ${
                collapsed ? 'h-9 w-9' : 'min-h-[36px] whitespace-nowrap border border-slate-700 px-1.5'
              }`}
            >
              <MonitorSmartphone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {!collapsed && <span>All Sessions</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Tooltip for the icon-only rail (fixed, so the scrolling menu never clips it) */}
      <AnimatePresence>
        {collapsed && tooltip && (
          <motion.div
            key={tooltip.label}
            id={tooltipId}
            role="tooltip"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ top: tooltip.top }}
            className="pointer-events-none fixed left-[84px] z-50 -translate-y-1/2 whitespace-nowrap rounded-lg border-2 border-slate-950 bg-bento-lime px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wider text-slate-950 shadow-[3px_3px_0_#000]"
          >
            {tooltip.label}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AdminSidebar<T extends string>(props: AdminSidebarProps<T>) {
  const { mobileOpen, onMobileClose, onSelect, ...rest } = props;
  // Expanded on the server and the first client render; the stored preference applies after mount
  const [collapsed, setCollapsed] = useState(false);
  // The width transition is enabled only after the stored preference is applied (no slide on page load)
  const [animateWidth, setAnimateWidth] = useState(false);
  useEffect(() => {
    setCollapsed(readCollapsed());
    const id = window.setTimeout(() => setAnimateWidth(true), 50);
    return () => window.clearTimeout(id);
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      writeCollapsed(!prev);
      return !prev;
    });
  }, []);

  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, mobileOpen, onMobileClose);

  // The drawer is for narrow screens only: close it if the window grows past the breakpoint
  useEffect(() => {
    if (!mobileOpen) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (mq.matches) onMobileClose();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mobileOpen, onMobileClose]);

  return (
    <>
      {/* Desktop: sticky sidebar, 256 px or an 76 px icon rail */}
      <aside
        className={`sticky top-0 z-30 hidden h-screen shrink-0 select-none border-r-2 border-slate-800 bg-[#111625] lg:block ${animateWidth ? 'transition-[width] duration-200 ease-out motion-reduce:transition-none' : ''} ${
          collapsed ? 'w-[76px]' : 'w-64'
        }`}
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <SidebarPanel {...rest} onSelect={onSelect} variant="desktop" collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      {/* Below 1024 px: off-canvas drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            key="admin-nav-drawer"
            className="fixed inset-0 z-50 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onMobileClose} aria-hidden="true" />
            <motion.div
              ref={drawerRef}
              id="admin-nav-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Console navigation"
              className="absolute inset-y-0 left-0 w-[19rem] max-w-[86vw] border-r-2 border-slate-950 bg-[#111625] shadow-[6px_0_0_#C6F432]"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <SidebarPanel
                {...rest}
                variant="drawer"
                collapsed={false}
                onClose={onMobileClose}
                onSelect={(id) => {
                  onSelect(id);
                  onMobileClose();
                }}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
