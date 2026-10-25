import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Same typefaces as the public site; globals.css and tailwind reference these CSS variables.
const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap'
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap'
});

export const metadata: Metadata = {
  title: 'GCDIS Staff Console | Internal Use Only',
  description: 'Administrative console for GCDIS championship officials, technical inspectors and referees.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true
    }
  }
};

export default async function AdminRootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  // Per-request CSP nonce (src/middleware.ts). Reading the request headers renders the console per request, which a
  // nonce-based policy requires; Next.js adds the nonce to its own scripts. The console has no inline or <Script>
  // scripts; any added later must receive this nonce.
  const nonce = (await headers()).get('x-nonce');
  if (!nonce && process.env.NODE_ENV === 'production') console.warn('[csp] x-nonce request header missing');

  return (
    <html lang="en" className={`${plusJakartaSans.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-slate-900 text-slate-100 antialiased min-h-screen font-sans">
        {children}
      </body>
    </html>
  );
}
