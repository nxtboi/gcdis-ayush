import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { getSiteContent, getSponsors } from '@/lib/site-content';
import { SiteContentProvider } from '@/components/site/SiteContentProvider';
import { HomeSectionsProvider } from '@/components/site/HomeSectionsProvider';
import { getHomePage } from '@/lib/home-sections';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
});

const DEFAULT_TITLE = 'GCDIS | Galgotias Centre for Drone Intelligence & Simulation';
const DEFAULT_DESCRIPTION =
  'Official institutional website and competition management system for the Galgotias Centre for Drone Intelligence & Simulation (GCDIS), Galgotias University, and the National Drone Soccer Championship 2026.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: '%s | GCDIS'
  },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: '/' },
  applicationName: SITE_NAME,
  keywords: [
    'GCDIS',
    'Drone Soccer',
    'D20',
    'D40',
    'Autonomous UAV',
    'Aerial Robotics',
    'Flight Control',
    'National Championship'
  ],
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: '/',
    locale: 'en_IN',
    images: [{ url: '/images/gcdis-logo.png', width: 512, height: 512, alt: 'GCDIS, Galgotias University' }]
  },
  twitter: {
    card: 'summary',
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: ['/images/gcdis-logo.png']
  }
};

export default async function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  // Per-request CSP nonce (src/middleware.ts). Reading the request headers renders every page per request, which a
  // nonce-based policy requires; Next.js adds the nonce to its own scripts and data fetches keep their revalidate
  // caching. The site has no inline or <Script> scripts; any added later must receive this nonce. Scripts
  // inserted at run time (Razorpay Checkout, Google Identity) are trusted through 'strict-dynamic'.
  const nonce = (await headers()).get('x-nonce');
  if (!nonce && process.env.NODE_ENV === 'production') console.warn('[csp] x-nonce request header missing');

  // Site information and footer sponsors managed from the staff console (cached for 30 s; see lib/site-content.ts).
  const content = await getSiteContent();
  const showFooterSponsors = content.sponsorsSection.enabled && content.sponsorsSection.showOn.footer;
  const footerSponsors = showFooterSponsors ? await getSponsors('FOOTER') : [];
  // Home page sections hidden in the console: the navbar and footers drop links to them on every page.
  const { hiddenAnchors } = await getHomePage();

  return (
    <html lang="en" className={`${plusJakartaSans.variable} ${jetbrainsMono.variable} scroll-smooth`}>
      <body className="bg-slate-50 text-slate-900 font-sans antialiased min-h-screen selection:bg-blue-600 selection:text-white">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2.5 focus:text-sm focus:font-bold focus:text-slate-950 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
        >
          Skip to content
        </a>
        <SiteContentProvider content={content} sponsors={{ FOOTER: footerSponsors }}>
          <HomeSectionsProvider hiddenAnchors={hiddenAnchors}>{children}</HomeSectionsProvider>
        </SiteContentProvider>
      </body>
    </html>
  );
}
