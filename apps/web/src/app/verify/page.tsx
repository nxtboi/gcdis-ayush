import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { MotionRoot, Reveal } from '@/components/motion/Reveal';
import { VerifyForm } from '@/components/verify/VerifyForm';

const TITLE = 'Verify a Certificate';
const DESCRIPTION = 'Check the authenticity of a certificate issued by GCDIS, Galgotias University, against the GCDIS certificate register.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: null },
  openGraph: { title: `${TITLE} | GCDIS`, description: DESCRIPTION, url: '/verify' },
  twitter: { title: `${TITLE} | GCDIS`, description: DESCRIPTION },
  robots: { index: false, follow: false }
};

export default function VerifyIndexPage() {
  return (
    <MotionRoot>
      <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
        <Navbar />

        <main id="main">
          <section className="pb-20 pt-32">
            <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
              <Reveal className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl sm:p-8">
                <div className="space-y-3 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400" aria-hidden="true">
                    <ShieldCheck className="h-8 w-8" />
                  </div>
                  <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">Certificate Verification</h1>
                  <p className="mx-auto max-w-lg text-xs leading-relaxed text-slate-400">
                    Enter the certificate code printed on a GCDIS certificate to confirm that it is recorded in the GCDIS certificate register.
                    The code may also be reached by scanning the QR code on the certificate.
                  </p>
                </div>
                <VerifyForm />
              </Reveal>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </MotionRoot>
  );
}
