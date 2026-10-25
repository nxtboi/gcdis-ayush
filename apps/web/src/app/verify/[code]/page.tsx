'use client';

import React, { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { fetchApi } from '@/lib/api-client';
import { formatIssuedDate } from '@/lib/certificates';
import { VerifyForm } from '@/components/verify/VerifyForm';
import { Stagger, StaggerItem } from '@/components/motion/Stagger';
import { DURATION, EASE_FORMAL } from '@/components/motion/tokens';
import { ShieldCheck, CheckCircle2, XCircle, ArrowLeft, AlertTriangle, RotateCw } from 'lucide-react';

interface VerificationResult {
  isValid?: boolean;
  certificate?: {
    code?: string;
    recipientName?: string;
    teamName?: string;
    achievementTitle?: string;
    issuedDate?: string;
  };
  qrDataUrl?: string;
}

const stateMotion = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: DURATION.base, ease: EASE_FORMAL }
};

export default function VerificationPortalPage({ params }: { params: Promise<{ code: string }> }) {
  // Next.js 15: dynamic route params are delivered as a Promise; unwrap it with React.use().
  const { code: rawCode } = use(params);
  const code = rawCode.toUpperCase();
  const [certResult, setCertResult] = useState<VerificationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lookupError, setLookupError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLookupError(false);
    fetchApi<VerificationResult>(`/certificates/verify/${encodeURIComponent(code)}`)
      .then((data) => {
        if (!cancelled) setCertResult(data ?? null);
      })
      .catch(() => {
        // A failed request is not proof that the certificate is invalid: report it separately.
        if (!cancelled) {
          setCertResult(null);
          setLookupError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const cert = certResult?.isValid ? certResult.certificate : undefined;
  const state = loading ? 'loading' : lookupError ? 'error' : cert ? 'valid' : 'invalid';

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
        <Navbar />

        <main id="main">
          <section className="pb-20 pt-32">
            <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DURATION.slow, ease: EASE_FORMAL }}
                className="space-y-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl sm:p-8"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Link href="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Return to the GCDIS website
                  </Link>
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Certificate Register</p>
                </div>

                {/* Present from the first render so the page always has a top-level heading, even while loading. */}
                <h1 className="sr-only">GCDIS Certificate Verification</h1>

                <div aria-live="polite" aria-busy={loading}>
                  <AnimatePresence mode="wait" initial={false}>
                    {loading ? (
                      <motion.div key="loading" {...stateMotion} className="space-y-4 py-12 text-center text-sm text-slate-400">
                        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-[#22C55E] motion-reduce:animate-none" aria-hidden="true" />
                        <p>Checking the certificate code against the GCDIS certificate register…</p>
                      </motion.div>
                    ) : lookupError ? (
                      <motion.div key="error" {...stateMotion} role="alert" className="space-y-4 py-12 text-center">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-400" aria-hidden="true">
                          <AlertTriangle className="h-9 w-9" />
                        </div>
                        <h2 className="text-xl font-bold text-white">Verification Service Unavailable</h2>
                        <p className="mx-auto max-w-md text-xs text-slate-400">
                          The GCDIS certificate register could not be reached, so the code <code className="font-mono font-bold text-[#22C55E]">{code}</code> could not be
                          checked. This does not indicate that the certificate is invalid. Please try again shortly.
                        </p>
                        <button
                          type="button"
                          onClick={retry}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-xs font-bold uppercase text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
                        >
                          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Try Again
                        </button>
                      </motion.div>
                    ) : cert ? (
                      <motion.div key="valid" {...stateMotion} className="space-y-6 text-center">
                        <motion.div
                          initial={{ scale: 0.92, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ duration: DURATION.slow, ease: EASE_FORMAL, delay: 0.1 }}
                          className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          aria-hidden="true"
                        >
                          <ShieldCheck className="h-10 w-10" />
                        </motion.div>

                        <div>
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-300">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> VERIFIED OFFICIAL CERTIFICATE
                          </span>
                          <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-white [overflow-wrap:anywhere] sm:text-3xl">
                            {cert.achievementTitle || 'Certificate of Participation'}
                          </h2>
                          <p className="mt-2 text-xs text-slate-400">This certificate is recorded in the GCDIS certificate register.</p>
                        </div>

                        <Stagger as="dl" trigger="mount" delay={0.15} className="mx-auto max-w-lg space-y-0 rounded-xl border border-slate-800 bg-slate-950 p-6 text-left text-sm">
                          {[
                            ['Recipient', cert.recipientName],
                            ['Team', cert.teamName],
                            ['Certificate code', cert.code || code],
                            ['Date of issue', formatIssuedDate(cert.issuedDate)]
                          ].map(([label, value], i, rows) => (
                            <StaggerItem
                              key={label as string}
                              className={`flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-4 ${i < rows.length - 1 ? 'border-b border-slate-800' : ''}`}
                            >
                              <dt className="text-slate-400">{label}</dt>
                              <dd
                                className={`font-semibold [overflow-wrap:anywhere] sm:text-right ${
                                  label === 'Certificate code' ? 'font-mono text-[#22C55E]' : 'text-white'
                                }`}
                              >
                                {value || 'Not recorded'}
                              </dd>
                            </StaggerItem>
                          ))}
                        </Stagger>

                        {certResult?.qrDataUrl && (
                          <div className="space-y-2 pt-2">
                            <p className="text-xs text-slate-400">Verification QR code</p>
                            {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated by the API */}
                            <img
                              src={certResult.qrDataUrl}
                              alt={`QR code linking to the verification page for certificate ${cert.code || code}`}
                              width={128}
                              height={128}
                              className="mx-auto h-32 w-32 rounded-lg border border-slate-800 bg-white p-2"
                            />
                          </div>
                        )}
                      </motion.div>
                    ) : (
                      <motion.div key="invalid" {...stateMotion} className="space-y-4 py-12 text-center">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-400" aria-hidden="true">
                          <XCircle className="h-10 w-10" />
                        </div>
                        <h2 className="text-xl font-bold text-white">Certificate Code Not Found</h2>
                        <p className="mx-auto max-w-md text-xs text-slate-400">
                          The certificate code <code className="font-mono font-bold text-[#22C55E] [overflow-wrap:anywhere]">{code}</code> does not match any record in the GCDIS
                          certificate register. Please check the code printed on the certificate and try again, or contact the Secretariat if you
                          believe this is an error.
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="border-t border-slate-800 pt-6">
                  <VerifyForm key={state === 'invalid' ? code : 'blank'} defaultValue={state === 'invalid' ? code : ''} label="Verify another certificate" />
                </div>
              </motion.div>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </MotionConfig>
  );
}
