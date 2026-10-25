/**
 * Site content constants and defaults (no Nest / Prisma imports: also used by prisma/seed.ts).
 * Defaults mirror the constants in apps/web/src/lib/site.ts.
 */

export const SPONSOR_TIERS = ['TITLE', 'PLATINUM', 'GOLD', 'SILVER', 'PARTNER', 'ACADEMIC', 'MEDIA'] as const;
export type SponsorTierValue = (typeof SPONSOR_TIERS)[number];

export const SPONSOR_TIER_LABELS: Readonly<Record<SponsorTierValue, string>> = Object.freeze({
  TITLE: 'Title Sponsor',
  PLATINUM: 'Platinum Sponsor',
  GOLD: 'Gold Sponsor',
  SILVER: 'Silver Sponsor',
  PARTNER: 'Partner',
  ACADEMIC: 'Academic Partner',
  MEDIA: 'Media Partner'
});

export const SPONSOR_PLACEMENTS = ['HOME', 'EVENT', 'FOOTER'] as const;
export type SponsorPlacement = (typeof SPONSOR_PLACEMENTS)[number];

/** Sponsors belong to the main championship event. */
export const MAIN_EVENT_SLUG = 'drone-soccer-2026';

export const SITE_SETTING_KEYS = Object.freeze({
  siteInfo: 'site_info',
  sponsorsSection: 'sponsors_section',
  gallerySection: 'gallery_section'
});

/**
 * Site setting holding the championship page media (hero video, poster and photo gallery) as JSON, validated
 * by ChampionshipMediaSchema (dto/championship-media.schema.ts). Not part of SITE_SETTING_KEYS: it is read by
 * its own endpoints (GET /cms/public/championship-media), not by GET /cms/public/site.
 */
export const CHAMPIONSHIP_MEDIA_SETTING_KEY = 'championship_media';

export interface SitePhone {
  display: string;
  tel: string;
}

export interface SiteSocialLinks {
  linkedin?: string | null;
  instagram?: string | null;
  youtube?: string | null;
  x?: string | null;
  facebook?: string | null;
}

export interface SiteInfo {
  organisationName: string;
  shortName: string;
  universityName: string;
  addressLines: string[];
  phones: SitePhone[];
  email: string;
  mapUrl: string | null;
  social: SiteSocialLinks;
  aboutImageUrl: string | null;
  aboutImageAlt: string | null;
}

export interface SponsorsSection {
  enabled: boolean;
  title: string;
  subtitle: string;
  showOn: { home: boolean; event: boolean; footer: boolean };
}

export interface GallerySection {
  enabled: boolean;
  title: string;
  subtitle: string;
}

export const DEFAULT_SITE_INFO: SiteInfo = Object.freeze({
  organisationName: 'Galgotias Centre for Drone Intelligence & Simulation',
  shortName: 'GCDIS',
  universityName: 'Galgotias University',
  addressLines: [
    'Galgotias University',
    'Plot No. 2, Sector 17-A, Yamuna Expressway',
    'Opposite Buddha International Circuit',
    'Greater Noida, Gautam Buddh Nagar, Uttar Pradesh 203201'
  ],
  phones: [
    { display: '0120-4806827', tel: '+911204806827' },
    { display: '0120-4806824', tel: '+911204806824' }
  ],
  email: 'gcdisgalgotias@gmail.com',
  mapUrl: null,
  social: {},
  aboutImageUrl: null,
  aboutImageAlt: null
}) as SiteInfo;

export const DEFAULT_SPONSORS_SECTION: SponsorsSection = Object.freeze({
  enabled: true,
  title: 'Sponsors and Partners',
  subtitle: '',
  showOn: { home: true, event: true, footer: true }
}) as SponsorsSection;

export const DEFAULT_GALLERY_SECTION: GallerySection = Object.freeze({
  enabled: true,
  title: 'Gallery',
  subtitle: ''
}) as GallerySection;

/** Fresh deep copies (callers may mutate). */
export function defaultSiteInfo(): SiteInfo {
  return JSON.parse(JSON.stringify(DEFAULT_SITE_INFO));
}
export function defaultSponsorsSection(): SponsorsSection {
  return JSON.parse(JSON.stringify(DEFAULT_SPONSORS_SECTION));
}
export function defaultGallerySection(): GallerySection {
  return JSON.parse(JSON.stringify(DEFAULT_GALLERY_SECTION));
}
