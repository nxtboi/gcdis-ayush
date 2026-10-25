/** Server-safe site constants used for metadata, sitemap and robots. */
export const SITE_NAME = 'GCDIS Official Platform';

/** Official GCDIS contact email (shown in the footer, contact desk, portal and mailto links). */
export const ORG_EMAIL = 'gcdisgalgotias@gmail.com';

/** Official postal address and telephone numbers of Galgotias University (host of GCDIS). */
export const ORG_ADDRESS_LINES = [
  'Galgotias University',
  'Plot No. 2, Sector 17-A, Yamuna Expressway',
  'Opposite Buddha International Circuit',
  'Greater Noida, Gautam Buddh Nagar, Uttar Pradesh 203201'
] as const;

export const ORG_PHONES = [
  { display: '0120-4806827', tel: '+911204806827' },
  { display: '0120-4806824', tel: '+911204806824' }
] as const;

/**
 * Canonical public site URL (no trailing slash). Configure NEXT_PUBLIC_SITE_URL in each environment;
 * the localhost fallback is used only in development, otherwise the production domain.
 */
export const SITE_URL: string = (
  process.env.NEXT_PUBLIC_SITE_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : 'https://www.gcdis.in')
).replace(/\/$/, '');

/** Format a URL slug such as `drone-soccer-2026` into a title (`Drone Soccer 2026`). */
export function titleFromSlug(slug: string): string {
  return decodeURIComponent(slug)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
