'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { Menu, X, LogOut, ArrowRight } from 'lucide-react';
import { fetchApi } from '@/lib/api-client';
import { Logo } from '@/components/brand/Logo';
import { EASE_FORMAL } from '@/components/motion/tokens';
import { CHAMPIONSHIP_PATH } from '@/lib/championship';
import { useHiddenHomeSections } from '@/components/site/HomeSectionsProvider';

interface NavItem {
  label: string;
  href: string;
  /** Landing-page section id used for scroll-spy highlighting. */
  section?: string;
  live?: boolean;
}

// Only destinations that exist: landing-page sections (in page order) plus the championship page.
const NAV_ITEMS: NavItem[] = [
  { label: 'About', href: '/#about', section: 'about' },
  { label: 'Programmes', href: '/#programmes', section: 'programmes' },
  { label: 'Services', href: '/#services', section: 'services' },
  { label: 'News', href: '/#news', section: 'news' },
  { label: 'Championship 2026', href: CHAMPIONSHIP_PATH, live: true },
  { label: 'Contact', href: '/#contact', section: 'contact' }
];

const EASE_OUT = EASE_FORMAL;

export const Navbar: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const isHome = pathname === '/';
  // Links to home page sections hidden in the staff console are not shown.
  const hiddenSections = useHiddenHomeSections();
  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.section || !hiddenSections.includes(item.section)),
    [hiddenSections]
  );

  // Check the real session (httpOnly cookie) via the API on mount and route change; any failure = logged out.
  useEffect(() => {
    let cancelled = false;
    fetchApi<{ user?: unknown }>('/auth/me')
      .then((res) => {
        if (!cancelled) setIsLoggedIn(Boolean(res?.user));
      })
      .catch(() => {
        if (!cancelled) setIsLoggedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Compact, more opaque bar once the page scrolls.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Scroll-spy: highlight the landing-page section currently in view.
  useEffect(() => {
    if (!isHome) {
      setActiveSection(null);
      return;
    }
    const sections = navItems.map((item) => item.section)
      .filter((id): id is string => Boolean(id))
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      // A band across the middle of the viewport decides which section is "current".
      { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5, 1] }
    );
    sections.forEach((el) => observer.observe(el));
    const clearAtTop = () => {
      if (window.scrollY < 200) setActiveSection(null);
    };
    window.addEventListener('scroll', clearAtTop, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', clearAtTop);
    };
  }, [isHome, navItems]);

  // Close the mobile menu on navigation and with Escape; lock page scroll while it is open.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetchApi('/auth/logout', { method: 'POST' });
    } catch {
      // Cookies are cleared server-side when reachable; locally we still treat the user as logged out.
    } finally {
      setIsLoggedIn(false);
      setIsLoggingOut(false);
      setIsOpen(false);
      router.refresh();
    }
  };

  const isActive = useCallback(
    (item: NavItem) => (item.section ? isHome && activeSection === item.section : pathname.startsWith(item.href)),
    [activeSection, isHome, pathname]
  );

  return (
    <MotionConfig reducedMotion="user">
      <header className="fixed left-0 right-0 top-4 z-50 px-4 sm:px-6 lg:px-8">
        <div
          className={`mx-auto flex max-w-6xl items-center justify-between rounded-full border px-3 shadow-2xl backdrop-blur-md transition-[padding,background-color,border-color,box-shadow] duration-300 sm:px-4 ${
            scrolled
              ? 'border-slate-600/70 bg-[#0b1120]/95 py-1.5 shadow-black/40'
              : 'border-slate-700/60 bg-[#111827]/90 py-2 shadow-black/20'
          }`}
        >
          {/* Brand */}
          <Link
            href="/"
            aria-label="GCDIS home"
            className="group flex items-center rounded-full pr-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22C55E]"
          >
            <span className="transition-transform duration-300 ease-out group-hover:scale-105">
              <Logo size={scrolled ? 36 : 40} withWordmark priority />
            </span>
          </Link>

          {/* Desktop links: a pill slides between hovered items; the current page/section gets a green marker */}
          <nav aria-label="Primary" className="hidden lg:block">
            <ul className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider" onMouseLeave={() => setHovered(null)}>
              {navItems.map((item) => {
                const active = isActive(item);
                return (
                  <li key={item.label} className="relative">
                    <Link
                      href={item.href}
                      onMouseEnter={() => setHovered(item.label)}
                      onFocus={() => setHovered(item.label)}
                      onBlur={() => setHovered(null)}
                      aria-current={active ? (item.section ? 'location' : 'page') : undefined}
                      className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-2 transition-colors duration-200 focus-visible:outline-none ${
                        active || item.live ? 'text-[#4ADE80]' : 'text-slate-200 hover:text-white'
                      }`}
                    >
                      {hovered === item.label && (
                        <motion.span
                          layoutId="nav-hover-pill"
                          className="absolute inset-0 rounded-full bg-white/10"
                          transition={{ duration: 0.3, ease: EASE_OUT }}
                          aria-hidden="true"
                        />
                      )}
                      {item.live && (
                        <span className="relative flex h-2 w-2" aria-hidden="true">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22C55E] opacity-60" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-[#22C55E]" />
                        </span>
                      )}
                      <span className={item.live ? 'nav-live-blink relative' : 'relative'}>{item.label}</span>
                      {active && (
                        <motion.span
                          layoutId="nav-active-marker"
                          className="absolute inset-x-0 -bottom-0.5 mx-auto h-0.5 w-5 rounded-full bg-[#22C55E]"
                          transition={{ duration: 0.35, ease: EASE_OUT }}
                          aria-hidden="true"
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Right: portal call-to-action */}
          <div className="flex items-center gap-2">
            <Link
              href="/portal"
              className="group hidden items-center gap-1.5 rounded-full bg-[#22C55E] px-5 py-2 text-xs font-extrabold uppercase tracking-wider text-slate-950 shadow-md shadow-[#22C55E]/20 transition-[background-color,box-shadow] duration-200 hover:bg-[#16A34A] hover:shadow-lg hover:shadow-[#22C55E]/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22C55E] sm:flex"
            >
              {isLoggedIn ? (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-slate-950" aria-hidden="true" />
                  <span>Team Portal</span>
                </>
              ) : (
                <span>Register / Sign In</span>
              )}
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 ease-out group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
            {isLoggedIn && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                aria-label="Sign out"
                title="Sign out"
                className="hidden h-9 w-9 items-center justify-center rounded-full border border-slate-700 text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50 sm:flex"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </button>
            )}

            {/* Mobile menu toggle with icon cross-fade */}
            <button
              type="button"
              onClick={() => setIsOpen((open) => !open)}
              aria-expanded={isOpen}
              aria-controls="mobile-nav"
              aria-label={isOpen ? 'Close navigation' : 'Open navigation'}
              className="relative flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 lg:hidden"
            >
              <AnimatePresence initial={false} mode="wait">
                <motion.span
                  key={isOpen ? 'close' : 'open'}
                  initial={{ opacity: 0, rotate: -90 }}
                  animate={{ opacity: 1, rotate: 0 }}
                  exit={{ opacity: 0, rotate: 90 }}
                  transition={{ duration: 0.2 }}
                >
                  {isOpen ? <X className="h-6 w-6" aria-hidden="true" /> : <Menu className="h-6 w-6" aria-hidden="true" />}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {isOpen && (
            <>
              <motion.div
                key="backdrop"
                className="fixed inset-0 -z-10 bg-slate-950/50 backdrop-blur-sm lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                onClick={() => setIsOpen(false)}
                aria-hidden="true"
              />
              <motion.nav
                key="panel"
                id="mobile-nav"
                aria-label="Mobile"
                initial={{ opacity: 0, y: -12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.98 }}
                transition={{ duration: 0.3, ease: EASE_OUT }}
                className="mx-auto mt-2 max-h-[80vh] max-w-6xl origin-top overflow-y-auto rounded-3xl border border-slate-700 bg-[#111827] p-3 shadow-2xl lg:hidden"
              >
                <motion.ul
                  initial="hidden"
                  animate="visible"
                  variants={{ visible: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } }}
                  className="space-y-1 text-sm font-bold uppercase tracking-wider"
                >
                  {navItems.map((item) => {
                    const active = isActive(item);
                    return (
                      <motion.li
                        key={item.label}
                        variants={{ hidden: { opacity: 0, x: -8 }, visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE_OUT } } }}
                      >
                        <Link
                          href={item.href}
                          onClick={() => setIsOpen(false)}
                          aria-current={active ? (item.section ? 'location' : 'page') : undefined}
                          className={`flex items-center justify-between rounded-2xl px-4 py-3 transition-colors ${
                            item.live
                              ? 'border border-[#22C55E]/30 bg-[#22C55E]/10 text-[#4ADE80]'
                              : active
                                ? 'bg-white/10 text-white'
                                : 'text-slate-200 hover:bg-white/5 hover:text-white'
                          }`}
                        >
                          <span className={item.live ? 'nav-live-blink' : undefined}>{item.label}</span>
                          {item.live ? (
                            <span className="h-2 w-2 animate-pulse rounded-full bg-[#22C55E]" aria-hidden="true" />
                          ) : (
                            <ArrowRight className="h-4 w-4 text-slate-500" aria-hidden="true" />
                          )}
                        </Link>
                      </motion.li>
                    );
                  })}
                </motion.ul>

                <div className="mt-3 space-y-2 border-t border-slate-800 px-1 pt-3">
                  <Link
                    href="/portal"
                    onClick={() => setIsOpen(false)}
                    className="block w-full rounded-full bg-[#22C55E] py-3 text-center text-xs font-extrabold uppercase tracking-wider text-slate-950 shadow-md shadow-[#22C55E]/20"
                  >
                    {isLoggedIn ? 'Team Portal' : 'Register / Sign In'}
                  </Link>
                  {isLoggedIn && (
                    <button
                      type="button"
                      onClick={handleLogout}
                      disabled={isLoggingOut}
                      className="block w-full rounded-full border border-slate-700 py-2.5 text-center text-xs font-bold uppercase text-slate-300 hover:text-white disabled:opacity-50"
                    >
                      {isLoggingOut ? 'Signing out…' : 'Sign out'}
                    </button>
                  )}
                </div>
              </motion.nav>
            </>
          )}
        </AnimatePresence>
      </header>
    </MotionConfig>
  );
};
