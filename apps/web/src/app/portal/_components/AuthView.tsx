'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Logo } from '@/components/brand/Logo';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion';
import { Lock, Mail, User, Check, AlertCircle, Trophy, BadgeCheck, Radio } from 'lucide-react';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import GoogleSignInButton, { type GoogleAuthUser } from './GoogleSignInButton';
import type { CategoriesState } from './categories';
import { Field, PasswordInput, SubmitButton, inputBase } from './AuthFields';
import ForgotPasswordForm from './ForgotPasswordForm';
import RegisterWizard from './RegisterWizard';

export interface RegisterFormData {
  teamName: string;
  /** Category id from GET /events/drone-soccer-2026. */
  category: string;
  institute: string;
  city: string;
  captainName: string;
  captainEmail: string;
  captainMobile: string;
  password: string;
  confirmPassword: string;
}

interface AuthViewProps {
  authMode: 'login' | 'register';
  setAuthMode: (mode: 'login' | 'register') => void;
  loginEmail: string;
  setLoginEmail: (value: string) => void;
  loginPassword: string;
  setLoginPassword: (value: string) => void;
  regData: RegisterFormData;
  setRegData: (value: RegisterFormData) => void;
  handleLoginSubmit: (e: React.FormEvent) => void;
  handleRegisterSubmit: (e: React.FormEvent) => void;
  showLogoutToast: boolean;
  authError: string | null;
  isSubmitting: boolean;
  /** Called after POST /auth/google succeeds; wired to the same success path as password login. */
  onGoogleSuccess: (user: GoogleAuthUser) => void;
  /** Surfaces Google sign-in failures through the shared authError banner. */
  onGoogleError: (message: string) => void;
  /** Championship categories loaded from the API (real category ids). */
  categoriesState: CategoriesState;
}

// Formal motion: short travel, eased deceleration, no bounce.
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

const PORTAL_POINTS = [
  {
    icon: Trophy,
    title: 'Championship 2026',
    body: 'Class 20 and Class 40 categories, conducted under the current FIDA rulebooks.'
  },
  {
    icon: BadgeCheck,
    title: 'Team records',
    body: 'Team passes, invoices and certificates in one place.'
  },
  {
    icon: Radio,
    title: 'Match information',
    body: 'Fixtures and official results as they are published.'
  }
];

/** Logged-out view of the participant portal: sign-in and team registration forms. */
export default function AuthView({
  authMode,
  setAuthMode,
  loginEmail,
  setLoginEmail,
  loginPassword,
  setLoginPassword,
  regData,
  setRegData,
  handleLoginSubmit,
  handleRegisterSubmit,
  showLogoutToast,
  authError,
  isSubmitting,
  onGoogleSuccess,
  onGoogleError,
  categoriesState
}: AuthViewProps) {
  const reduceMotion = useReducedMotion();
  // Secretariat email managed from the staff console (falls back to lib/site.ts)
  const secretariatEmail = useSiteInfo().email;
  const errorRef = useRef<HTMLDivElement>(null);
  // "Forgotten password?" replaces the sign-in form with the reset request form
  // (opened directly by /portal#forgot-password, for example from an expired reset link)
  const [showForgot, setShowForgot] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#forgot-password'
  );
  const loginView = authMode === 'login' && showForgot ? 'forgot' : authMode;
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === '#forgot-password') {
        setAuthMode('login');
        setShowForgot(true);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setAuthMode]);

  // A long registration form can push the error banner out of view: bring it back into view when it appears.
  useEffect(() => {
    if (!authError) return;
    const id = window.setTimeout(() => {
      errorRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: reduceMotion ? 'auto' : 'smooth'
      });
    }, 50);
    return () => window.clearTimeout(id);
  }, [authError, reduceMotion]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-screen bg-[#0b1120] font-sans text-slate-900 selection:bg-blue-600 selection:text-white lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        {/* ── Left: brand panel with lab photograph (full-bleed background on small screens) ── */}
        {/* Pinned to the viewport on desktop so it looks identical for sign-in and the longer registration form */}
        <aside className="fixed inset-0 overflow-hidden lg:sticky lg:top-0 lg:h-screen lg:self-start" aria-hidden="false">
          <div className="hero-kenburns absolute inset-0" aria-hidden="true">
            <Image
              src="/images/gcdis-drone-lab.jpg"
              alt=""
              fill
              priority
              sizes="(min-width: 1024px) 52vw, 100vw"
              className="object-cover object-center"
            />
          </div>
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(160deg, rgba(11,17,32,0.88) 0%, rgba(11,17,32,0.70) 50%, rgba(11,17,32,0.95) 100%), radial-gradient(ellipse at 30% 40%, rgba(37,99,235,0.20), transparent 60%)'
            }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]"
          />

          <div className="relative hidden h-full flex-col justify-between p-10 text-white lg:flex xl:p-14">
            <Link href="/" className="hero-rise flex w-fit items-center gap-2.5" style={{ animationDelay: '0.1s' }}>
              <Logo size={44} withWordmark priority />
            </Link>

            <div className="max-w-lg">
              <p
                className="hero-rise font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#4ADE80]"
                style={{ animationDelay: '0.2s' }}
              >
                Team Portal
              </p>
              <h2
                className="hero-rise mt-4 text-4xl font-black uppercase leading-[1.05] tracking-tight xl:text-5xl"
                style={{ animationDelay: '0.32s' }}
              >
                Team registration and management for the
                <span className="mt-2 block w-fit rounded-md bg-[#2563EB] px-3 py-0.5 shadow-lg shadow-blue-900/40">
                  Championship 2026
                </span>
              </h2>
              <div
                className="hero-rule mt-6 h-1 w-16 origin-left rounded-full bg-[#22C55E]"
                style={{ animationDelay: '0.5s' }}
                aria-hidden="true"
              />

              <ul className="mt-8 space-y-5">
                {PORTAL_POINTS.map((point, i) => (
                  <li key={point.title} className="hero-rise flex gap-4" style={{ animationDelay: `${0.55 + i * 0.12}s` }}>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm">
                      <point.icon className="h-5 w-5 text-[#4ADE80]" aria-hidden="true" />
                    </span>
                    <span>
                      <span className="block text-sm font-bold">{point.title}</span>
                      <span className="block text-sm text-slate-300">{point.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="hero-rise font-mono text-[11px] text-slate-400" style={{ animationDelay: '0.95s' }}>
              Galgotias Centre for Drone Intelligence &amp; Simulation • Galgotias University
            </p>
          </div>
        </aside>

        {/* ── Right: authentication card ── */}
        <main className="relative flex min-h-screen flex-col lg:bg-slate-50">
          {/* Top bar */}
          <header className="flex items-center justify-between gap-4 px-4 pt-5 sm:px-8">
            <Link href="/" className="flex items-center gap-2 lg:hidden">
              <Logo size={36} withWordmark />
            </Link>
            <nav aria-label="Portal" className="ml-auto flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider">
              <Link
                href="/"
                className="rounded-full px-3 py-1.5 text-slate-200 transition-colors hover:text-white lg:text-slate-600 lg:hover:bg-slate-200/60 lg:hover:text-slate-950"
              >
                Home
              </Link>
              <Link
                href="/events/drone-soccer-2026"
                className="rounded-full px-3 py-1.5 text-slate-200 transition-colors hover:text-white lg:text-slate-600 lg:hover:bg-slate-200/60 lg:hover:text-slate-950"
              >
                <span className="whitespace-nowrap sm:hidden">Championship</span>
                <span className="hidden whitespace-nowrap sm:inline">Championship 2026</span>
              </Link>
            </nav>
          </header>

          {/* Logout feedback toast */}
          <AnimatePresence>
            {showLogoutToast && (
              <motion.div
                role="status"
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.35, ease: EASE_OUT }}
                className="fixed left-1/2 top-5 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-slate-700/80 bg-[#111625] px-5 py-2.5 text-xs font-bold text-white shadow-2xl"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#22C55E]/20 text-[#22C55E]">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span>You have been signed out.</span>
                <Link href="/" className="ml-1 font-mono text-[11px] text-[#22C55E] hover:underline">
                  HOME &rarr;
                </Link>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
            <div
              className="hero-rise w-full max-w-lg rounded-3xl border border-slate-200/90 bg-white p-6 shadow-2xl shadow-slate-900/20 sm:p-9 lg:shadow-xl lg:shadow-slate-200/60"
              style={{ animationDelay: '0.2s' }}
            >
              {/* Card header */}
              <div className="space-y-2 text-center">
                <div className="mx-auto w-fit">
                  <Logo size={64} />
                </div>
                <h1 className="text-2xl font-black uppercase tracking-tight text-slate-950 sm:text-3xl">
                  {loginView === 'forgot' ? 'Reset your password' : authMode === 'login' ? 'Sign in' : 'Team registration'}
                </h1>
                <p className="text-sm text-slate-600">
                  {loginView === 'forgot'
                    ? 'Enter the email address of your team captain account. A link to set a new password will be sent to it.'
                    : authMode === 'login'
                      ? 'Sign in with your team captain account to access the team dashboard.'
                      : 'Create the team captain account for your Drone Soccer Championship 2026 entry.'}
                </p>
              </div>

              {/* Segmented switch with a sliding indicator */}
              <div
                role="group"
                aria-label="Choose sign in or registration"
                className="relative mt-6 grid grid-cols-2 rounded-full border border-slate-200 bg-slate-100 p-1.5 text-xs font-bold"
              >
                {(
                  [
                    { mode: 'login', label: 'SIGN IN', icon: Lock },
                    { mode: 'register', label: 'REGISTER TEAM', icon: User }
                  ] as const
                ).map(({ mode, label, icon: Icon }) => {
                  const active = authMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setShowForgot(false);
                        setAuthMode(mode);
                      }}
                      aria-pressed={active}
                      className={`relative flex items-center justify-center gap-2 rounded-full py-2.5 transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E] ${
                        active ? 'text-white' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="auth-mode-indicator"
                          className="absolute inset-0 rounded-full bg-[#111625] shadow-md"
                          transition={{ duration: 0.35, ease: EASE_OUT }}
                          aria-hidden="true"
                        />
                      )}
                      <Icon className="relative h-3.5 w-3.5" aria-hidden="true" />
                      <span className="relative">{label}</span>
                    </button>
                  );
                })}
              </div>

              <AnimatePresence initial={false}>
                {authError && (
                  <motion.div
                    key="auth-error"
                    ref={errorRef}
                    role="alert"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <div className="mt-5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{authError}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Forms cross-fade when switching modes */}
              <AnimatePresence mode="wait" initial={false}>
                {loginView === 'forgot' ? (
                  <motion.div
                    key="forgot"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                    className="mt-6"
                  >
                    <ForgotPasswordForm
                      initialEmail={loginEmail}
                      onBack={() => {
                        setShowForgot(false);
                        if (window.location.hash === '#forgot-password') {
                          window.history.replaceState(null, '', window.location.pathname);
                        }
                      }}
                    />
                  </motion.div>
                ) : authMode === 'login' ? (
                  <motion.form
                    key="login"
                    onSubmit={handleLoginSubmit}
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                    className="mt-6 space-y-4"
                  >
                    <Field id="login-email" label="Captain Email Address">
                      <div className="relative">
                        <Mail
                          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                          aria-hidden="true"
                        />
                        <input
                          id="login-email"
                          autoComplete="email"
                          type="email"
                          required
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          className={`${inputBase} pl-9 pr-3`}
                          placeholder="captain@institution.ac.in"
                        />
                      </div>
                    </Field>

                    <Field
                      id="login-password"
                      label="Password"
                      aside={
                        <button
                          type="button"
                          onClick={() => setShowForgot(true)}
                          className="text-[11px] font-semibold text-[#15803D] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E]"
                        >
                          Forgotten password?
                        </button>
                      }
                    >
                      <PasswordInput
                        id="login-password"
                        value={loginPassword}
                        onChange={setLoginPassword}
                        autoComplete="current-password"
                        withIcon
                      />
                    </Field>

                    <SubmitButton busy={isSubmitting} idle="Sign in" busyLabel="Signing in…" />

                    <GoogleSignInButton
                      mode="login"
                      onGoogleSuccess={onGoogleSuccess}
                      onGoogleError={onGoogleError}
                      disabled={isSubmitting}
                    />

                    <p className="pt-1 text-center text-xs text-slate-500">
                      Not yet registered?{' '}
                      <button
                        type="button"
                        onClick={() => setAuthMode('register')}
                        className="font-bold text-[#15803D] hover:underline"
                      >
                        Register a team
                      </button>
                    </p>
                  </motion.form>
                ) : (
                  <RegisterWizard
                    key="register"
                    regData={regData}
                    setRegData={setRegData}
                    handleRegisterSubmit={handleRegisterSubmit}
                    isSubmitting={isSubmitting}
                    categoriesState={categoriesState}
                    onGoogleSuccess={onGoogleSuccess}
                    onGoogleError={onGoogleError}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>

          <footer className="px-4 pb-6 text-center font-mono text-[11px] text-slate-300 lg:text-slate-500">
            Enquiries:{' '}
            <a href={`mailto:${secretariatEmail}`} className="font-bold underline-offset-2 hover:underline">
              {secretariatEmail}
            </a>
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}
