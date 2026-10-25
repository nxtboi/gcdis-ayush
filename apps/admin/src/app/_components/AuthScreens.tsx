'use client';

import { QRCodeSVG } from 'qrcode.react';
import React from 'react';
import Image from 'next/image';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowRight, Check, Circle, Eye, EyeOff, Info, KeyRound, ShieldCheck, X } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, passwordChecks } from '@/lib/password-policy';

const INPUT_CLASS =
  'w-full bg-[#182035] border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-400 focus:outline-none focus:border-[#22C55E]';
const CODE_INPUT_CLASS =
  'w-full bg-[#182035] border border-slate-700 rounded-xl px-4 py-3 text-center text-xl tracking-widest text-[#22C55E] font-mono font-black focus:outline-none focus:border-[#22C55E]';
const PRIMARY_BUTTON_CLASS =
  'w-full py-3.5 bg-[#22C55E] hover:bg-[#16A34A] disabled:opacity-60 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg shadow-[#22C55E]/20 flex items-center justify-center gap-2 active:translate-y-px motion-reduce:transform-none disabled:cursor-not-allowed';

/** Short fade for messages on the sign-in screens (layout is unchanged; reduced motion keeps only the fade). */
const MESSAGE_MOTION = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const } },
  exit: { opacity: 0, transition: { duration: 0.12 } }
};

function AuthError({ message }: { message: string | null }) {
  return (
    <div role="alert">
      <AnimatePresence initial={false}>
        {message && (
          <motion.div
            key={message}
            {...MESSAGE_MOTION}
            className="p-3.5 bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded-xl text-xs flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AuthNotice({ message }: { message?: string | null }) {
  return (
    <div role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {message && (
          <motion.div
            key={message}
            {...MESSAGE_MOTION}
            className="p-3.5 bg-sky-500/10 border border-sky-500/30 text-sky-200 rounded-xl text-xs flex items-center gap-2"
          >
            <Info className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Shell({ children, accent = 'green' }: { children: React.ReactNode; accent?: 'green' | 'amber' }) {
  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex flex-col items-center justify-center gap-6 p-4">
      <div className="admin-rise flex flex-col items-center gap-2">
        <Image
          src="/gcdis-logo.png"
          alt="GCDIS, Galgotias University"
          width={72}
          height={72}
          priority
          className="rounded-full bg-white shadow-lg shadow-black/40 ring-1 ring-white/10"
        />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Galgotias University</span>
      </div>
      <div
        className={`admin-rise w-full max-w-md bg-[#111625] border ${accent === 'amber' ? 'border-amber-500/40' : 'border-slate-800'
          } rounded-3xl p-8 shadow-2xl space-y-6`}
        style={{ animationDelay: '0.12s' }}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forced password change
// ---------------------------------------------------------------------------
/** Password policy with live checks for the rules that can be verified in the browser (breach check: server). */
export function PasswordPolicyList({ password, email, id = 'pw-policy' }: { password: string; email?: string | null; id?: string }) {
  const touched = password.length > 0;
  return (
    <div id={id} className="rounded-xl border border-slate-700/80 bg-[#0B0F19]/60 px-3.5 py-3">
      <p className="font-bold text-slate-300">Password requirements</p>
      <p className="mt-0.5 text-[11px] text-slate-400">
        Staff accounts need a password of at least {PASSWORD_MIN_LENGTH} characters. A password set earlier remains valid until it is changed.
      </p>
      <ul className="mt-1.5 space-y-1" aria-live="polite">
        {passwordChecks(password, email).map((check) => {
          const state =
            check.id === 'breached' ? 'server' : !touched || check.met === null ? 'idle' : check.met ? 'met' : 'unmet';
          return (
            <li key={check.id} className="flex items-start gap-2 leading-snug">
              <span className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                {state === 'met' && <Check className="h-3.5 w-3.5 text-[#22C55E]" />}
                {state === 'unmet' && <X className="h-3.5 w-3.5 text-rose-400" />}
                {state === 'idle' && <Circle className="h-2.5 w-2.5 text-slate-400" />}
                {state === 'server' && <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />}
              </span>
              <span
                className={`transition-colors duration-200 ${
                  state === 'met' ? 'text-[#4ADE80]' : state === 'unmet' ? 'text-rose-300' : 'text-slate-400'
                }`}
              >
                {check.label}
                <span className="sr-only">
                  {state === 'met' ? ' (met)' : state === 'unmet' ? ' (not met)' : state === 'server' ? ' (checked by the server)' : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface PasswordChangeScreenProps {
  /** Email of the signed-in staff member (the password must not contain its name part). */
  email?: string | null;
  authError: string | null;
  isLoading: boolean;
  currentPassword: string;
  setCurrentPassword: (value: string) => void;
  newPassword: string;
  setNewPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function PasswordChangeScreen(props: PasswordChangeScreenProps) {
  const [showPasswords, setShowPasswords] = React.useState(false);
  const amberInput =
    'w-full bg-[#182035] border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-amber-400 font-mono';
  const newType = showPasswords ? 'text' : 'password';
  return (
    <Shell accent="amber">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/40 text-amber-400 flex items-center justify-center mx-auto">
          <KeyRound className="w-6 h-6" aria-hidden="true" />
        </div>
        <span className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-widest block">Action Required</span>
        <h1 className="text-2xl font-black text-white uppercase tracking-tight">Change Your Temporary Password</h1>
        <p className="text-xs text-slate-400">
          You must replace the temporary password issued to you before you can use the staff console.
        </p>
      </div>

      <AuthError message={props.authError} />

      <form onSubmit={props.onSubmit} className="space-y-4 text-xs">
        <div>
          <label htmlFor="pw-current" className="block font-bold text-slate-300 mb-1">
            Current Temporary Password
          </label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            required
            value={props.currentPassword}
            onChange={(e) => props.setCurrentPassword(e.target.value)}
            className={amberInput}
          />
        </div>
        <div>
          <label htmlFor="pw-new" className="block font-bold text-slate-300 mb-1">
            New Password
          </label>
          <input
            id="pw-new"
            type={newType}
            autoComplete="new-password"
            required
            minLength={12}
            aria-describedby="pw-policy"
            value={props.newPassword}
            onChange={(e) => props.setNewPassword(e.target.value)}
            className={amberInput}
          />
        </div>
        <div>
          <label htmlFor="pw-confirm" className="block font-bold text-slate-300 mb-1">
            Confirm New Password
          </label>
          <input
            id="pw-confirm"
            type={newType}
            autoComplete="new-password"
            required
            value={props.confirmPassword}
            onChange={(e) => props.setConfirmPassword(e.target.value)}
            className={amberInput}
          />
          {props.confirmPassword.length > 0 && props.confirmPassword !== props.newPassword && (
            <p className="mt-1 font-semibold text-rose-300">The new passwords do not match.</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowPasswords((v) => !v)}
          aria-pressed={showPasswords}
          className="inline-flex items-center gap-1.5 font-bold text-slate-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 rounded"
        >
          {showPasswords ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
          {showPasswords ? 'Hide new password' : 'Show new password'}
        </button>
        <PasswordPolicyList password={props.newPassword} email={props.email} />
        <button
          type="submit"
          disabled={props.isLoading}
          className="w-full py-3.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg flex items-center justify-center gap-2"
        >
          <span>{props.isLoading ? 'Updating…' : 'Update Password and Continue'}</span>
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Recovery codes (shown once, right after 2FA enrolment)
// ---------------------------------------------------------------------------
export function RecoveryCodesScreen({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  return (
    <Shell>
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-[#22C55E]/15 border border-[#22C55E]/40 text-[#22C55E] flex items-center justify-center mx-auto">
          <ShieldCheck className="w-6 h-6" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-black text-white uppercase tracking-tight">Save Your Recovery Codes</h1>
        <p className="text-xs text-slate-400">
          Two-factor authentication is now enabled. Each code below (16 characters, in the form XXXX-XXXX-XXXX-XXXX) may be
          used once if you lose access to your authenticator application. Store them securely; they will not be shown again.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-2 p-4 bg-slate-900 rounded-xl font-mono text-xs text-slate-200 select-all" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button type="button" onClick={onContinue} className={PRIMARY_BUTTON_CLASS}>
        <span>I Have Saved These Codes</span>
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </button>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Login: email/password -> 2FA verification or enrolment
// ---------------------------------------------------------------------------
interface LoginScreenProps {
  authError: string | null;
  /** Informational notice, e.g. after signing out or changing the password. */
  authNotice?: string | null;
  isLoading: boolean;
  requires2fa: boolean;
  isEnrolmentMode: boolean;
  enrolmentData: { secret?: string; otpAuthUrl?: string } | null;
  loginEmail: string;
  setLoginEmail: (value: string) => void;
  loginPassword: string;
  setLoginPassword: (value: string) => void;
  twoFactorCode: string;
  setTwoFactorCode: (value: string) => void;
  onLogin: (e: React.FormEvent) => void;
  onVerify2fa: (e: React.FormEvent) => void;
  onBackToLogin: () => void;
}

export function LoginScreen(props: LoginScreenProps) {
  const codeInput = (id: string, label: string) => (
    <div>
      <label htmlFor={id} className="block font-bold text-slate-300 mb-1">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        value={props.twoFactorCode}
        onChange={(e) => props.setTwoFactorCode(e.target.value.replace(/\D/g, ''))}
        placeholder="123456"
        className={CODE_INPUT_CLASS}
      />
    </div>
  );

  const backButton = (
    <button type="button" onClick={props.onBackToLogin} className="w-full text-center text-[11px] text-slate-400 hover:text-white transition-colors">
      &larr; Return to Sign-In
    </button>
  );

  return (
    <Shell>
      <div className="text-center space-y-2">
        <span className="text-[10px] font-mono font-bold text-[#22C55E] uppercase tracking-widest block">Authorised Personnel Only</span>
        <h1 className="text-2xl font-black text-white uppercase tracking-tight">GCDIS Staff Console</h1>
        <p className="text-xs text-slate-400">Access is restricted to authorised championship officials, referees and technical inspectors.</p>
      </div>

      <AuthNotice message={props.authNotice} />
      <AuthError message={props.authError} />

      {!props.requires2fa ? (
        /* STEP 1: Email + Password */
        <form onSubmit={props.onLogin} className="space-y-4 text-xs">
          <div>
            <label htmlFor="login-email" className="block font-bold text-slate-300 mb-1">
              Email Address
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={props.loginEmail}
              onChange={(e) => props.setLoginEmail(e.target.value)}
              placeholder="admin@gcdis.in"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block font-bold text-slate-300 mb-1">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={props.loginPassword}
              onChange={(e) => props.setLoginPassword(e.target.value)}
              placeholder="••••••••••••"
              className={`${INPUT_CLASS} font-mono`}
            />
          </div>
          <button type="submit" disabled={props.isLoading} className={PRIMARY_BUTTON_CLASS}>
            <span>{props.isLoading ? 'Signing In…' : 'Continue to Verification'}</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </form>
      ) : props.isEnrolmentMode ? (
        /* STEP 2A: Mandatory 2FA Enrolment (scan the QR code or enter the key; recovery codes are shown after activation) */
        <form onSubmit={props.onVerify2fa} className="space-y-4 text-xs">
          <div className="bg-[#182035] p-3.5 rounded-xl border border-slate-700 text-[11px] text-slate-300 space-y-3">
            <span className="font-bold text-[#22C55E] block">Two-Factor Authentication Setup Required</span>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Open an authenticator application on your phone (for example, Google Authenticator or Microsoft Authenticator).</li>
              <li>Choose to add an account and scan the QR code below.</li>
              <li>Enter the six-digit code the application displays.</li>
            </ol>
            {props.enrolmentData?.otpAuthUrl ? (
              <div className="mx-auto w-fit rounded-xl bg-white p-3" role="img" aria-label="QR code for adding this account to an authenticator application">
                <QRCodeSVG value={props.enrolmentData.otpAuthUrl} size={176} level="M" />
              </div>
            ) : (
              <p className="text-amber-400">Generating the setup key…</p>
            )}
            {props.enrolmentData?.secret && (
              <div className="space-y-1">
                <p>If you cannot scan the code, enter this setup key manually (time-based):</p>
                <div className="p-2 bg-slate-900 rounded font-mono text-[11px] tracking-wider text-white break-all select-all">
                  {props.enrolmentData.secret.replace(/(.{4})/g, '$1 ').trim()}
                </div>
              </div>
            )}
            {props.enrolmentData?.otpAuthUrl && (
              <a href={props.enrolmentData.otpAuthUrl} className="inline-block text-[#22C55E] underline">
                Open in an authenticator application on this device
              </a>
            )}
          </div>
          {codeInput('enrol-code', 'Six-Digit Authentication Code')}
          <button type="submit" disabled={props.isLoading || !props.enrolmentData?.secret} className={PRIMARY_BUTTON_CLASS}>
            <span>{props.isLoading ? 'Confirming…' : 'Confirm and Sign In'}</span>
          </button>
          {backButton}
        </form>
      ) : (
        /* STEP 2B: Standard TOTP Verification */
        <form onSubmit={props.onVerify2fa} className="space-y-4 text-xs">
          <div className="bg-[#182035] p-3.5 rounded-xl border border-slate-700 text-[11px] text-slate-300">
            Enter the six-digit code currently shown in your authenticator application.
          </div>
          {codeInput('totp-code', 'Authentication Code')}
          <button type="submit" disabled={props.isLoading} className={PRIMARY_BUTTON_CLASS}>
            <span>{props.isLoading ? 'Verifying…' : 'Verify and Sign In'}</span>
          </button>
          {backButton}
        </form>
      )}
    </Shell>
  );
}
