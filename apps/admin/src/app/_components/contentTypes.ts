/**
 * Types, labels and client-side validation for the site content screens (sponsors, gallery, site
 * information) and the security screen. They mirror the API contract; the API remains the authority.
 */

// -------------------------------------------------------------
// SPONSORS
// -------------------------------------------------------------
export const SPONSOR_TIERS = ['TITLE', 'PLATINUM', 'GOLD', 'SILVER', 'PARTNER', 'ACADEMIC', 'MEDIA'] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export const SPONSOR_TIER_LABELS: Record<SponsorTier, string> = {
  TITLE: 'Title Sponsor',
  PLATINUM: 'Platinum Sponsor',
  GOLD: 'Gold Sponsor',
  SILVER: 'Silver Sponsor',
  PARTNER: 'Partner',
  ACADEMIC: 'Academic Partner',
  MEDIA: 'Media Partner'
};

export function sponsorTierLabel(tier?: string | null): string {
  return (tier && SPONSOR_TIER_LABELS[tier as SponsorTier]) || 'Partner';
}

/** Rank used by the public site: tier order first, then display order. */
export function sponsorTierRank(tier?: string | null): number {
  const index = SPONSOR_TIERS.indexOf(tier as SponsorTier);
  return index === -1 ? SPONSOR_TIERS.length : index;
}

export const SPONSOR_PLACEMENTS = ['HOME', 'EVENT', 'FOOTER'] as const;
export type SponsorPlacement = (typeof SPONSOR_PLACEMENTS)[number];

export const SPONSOR_PLACEMENT_LABELS: Record<SponsorPlacement, string> = {
  HOME: 'Home',
  EVENT: 'Championship',
  FOOTER: 'Footer'
};

export interface Sponsor {
  id: string;
  name: string;
  tier: SponsorTier;
  logoUrl: string | null;
  websiteUrl: string | null;
  description: string | null;
  placements: SponsorPlacement[];
  isActive: boolean;
  displayOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SponsorInput {
  name: string;
  tier: SponsorTier;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  description?: string | null;
  placements: SponsorPlacement[];
  isActive?: boolean;
  displayOrder?: number;
}

export interface SponsorsSection {
  enabled: boolean;
  title: string;
  subtitle: string;
  showOn: { home: boolean; event: boolean; footer: boolean };
}

export const DEFAULT_SPONSORS_SECTION: SponsorsSection = {
  enabled: true,
  title: 'Sponsors and Partners',
  subtitle: '',
  showOn: { home: true, event: true, footer: true }
};

/** Sponsors in the order the public site shows them: tier rank, then display order. */
export function sortSponsors(list: Sponsor[]): Sponsor[] {
  return [...list].sort(
    (a, b) => sponsorTierRank(a.tier) - sponsorTierRank(b.tier) || (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name)
  );
}

/** Active sponsors shown for one placement, in public order. */
export function sponsorsForPlacement(list: Sponsor[], placement: SponsorPlacement): Sponsor[] {
  return sortSponsors(list.filter((s) => s.isActive && s.placements.includes(placement)));
}

/**
 * Moves a sponsor one place up or down within its tier (the public order is by tier first, so moving
 * across tiers would have no effect). Returns the new order, or null when the move is not possible.
 */
export function moveSponsor(list: Sponsor[], id: string, direction: -1 | 1): Sponsor[] | null {
  const ordered = sortSponsors(list);
  const index = ordered.findIndex((s) => s.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= ordered.length) return null;
  if (ordered[target].tier !== ordered[index].tier) return null;
  const next = [...ordered];
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((s, i) => ({ ...s, displayOrder: i }));
}

export function validateSponsor(input: SponsorInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = 'Please enter the sponsor name.';
  else if (input.name.trim().length > 120) errors.name = 'The sponsor name must be 120 characters or fewer.';
  if (!SPONSOR_TIERS.includes(input.tier)) errors.tier = 'Please select a sponsorship tier.';
  if (input.websiteUrl && !isHttpsUrl(input.websiteUrl)) errors.websiteUrl = 'Please enter a complete web address beginning with https://.';
  if (input.description && input.description.length > 1000) errors.description = 'The description must be 1,000 characters or fewer.';
  if (input.placements.length === 0) errors.placements = 'Please select at least one place where the sponsor is shown.';
  return errors;
}

// -------------------------------------------------------------
// GALLERY
// -------------------------------------------------------------
export interface GalleryImage {
  id: string;
  imageUrl: string;
  title: string;
  caption: string | null;
  altText: string;
  category: string | null;
  isPublished: boolean;
  displayOrder: number;
  width: number | null;
  height: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface GalleryImageInput {
  imageUrl: string;
  title: string;
  altText: string;
  caption?: string | null;
  category?: string | null;
  isPublished?: boolean;
}

export interface GallerySection {
  enabled: boolean;
  title: string;
  subtitle: string;
}

export const DEFAULT_GALLERY_SECTION: GallerySection = { enabled: true, title: 'Gallery', subtitle: '' };

export function sortGallery(list: GalleryImage[]): GalleryImage[] {
  return [...list].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

/** Moves an item one place earlier (-1) or later (1); null when it is already at that end. */
export function moveItem<T extends { id: string }>(list: T[], id: string, direction: -1 | 1): T[] | null {
  const index = list.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= list.length) return null;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function validateGalleryDetails(input: { title: string; altText: string; caption?: string | null; category?: string | null }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.title.trim()) errors.title = 'Please enter a title.';
  else if (input.title.trim().length > 150) errors.title = 'The title must be 150 characters or fewer.';
  if (!input.altText.trim()) errors.altText = 'Please describe the image for visitors who use screen readers.';
  else if (input.altText.trim().length > 300) errors.altText = 'The alternative text must be 300 characters or fewer.';
  if (input.caption && input.caption.length > 1000) errors.caption = 'The caption must be 1,000 characters or fewer.';
  if (input.category && input.category.length > 60) errors.category = 'The category must be 60 characters or fewer.';
  return errors;
}

// -------------------------------------------------------------
// UPLOADS
// -------------------------------------------------------------
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const IMAGE_ACCEPT = IMAGE_MIME_TYPES.join(',');
export const IMAGE_TYPES_LABEL = 'JPEG, PNG or WebP';

const MB = 1024 * 1024;

/** Size limits per upload purpose, as enforced by the API. */
export const UPLOAD_LIMITS = {
  SPONSOR_LOGO: 2 * MB,
  GALLERY_IMAGE: 8 * MB,
  SITE_IMAGE: 8 * MB,
  CMS_BACKGROUND: 25 * MB
} as const;

export type ImageUploadPurpose = keyof typeof UPLOAD_LIMITS;

export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Describes the accepted files for a purpose, e.g. "JPEG, PNG or WebP, up to 2 MB". */
export function uploadHint(purpose: ImageUploadPurpose): string {
  return `${IMAGE_TYPES_LABEL}, up to ${formatBytes(UPLOAD_LIMITS[purpose])}`;
}

/** Client-side check before uploading; returns a formal message, or null when the file is acceptable. */
export function validateImageFile(file: { name: string; type: string; size: number }, purpose: ImageUploadPurpose): string | null {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name} is not a supported image. Please choose a ${IMAGE_TYPES_LABEL} file.`;
  }
  if (file.size > UPLOAD_LIMITS[purpose]) {
    return `${file.name} is ${formatBytes(file.size)}, which is larger than the permitted ${formatBytes(UPLOAD_LIMITS[purpose])}.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

// -------------------------------------------------------------
// SITE INFORMATION
// -------------------------------------------------------------
export const SOCIAL_NETWORKS = ['linkedin', 'instagram', 'youtube', 'x', 'facebook'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  youtube: 'YouTube',
  x: 'X (formerly Twitter)',
  facebook: 'Facebook'
};

export interface SitePhone {
  display: string;
  tel: string;
}

export interface SiteInfo {
  organisationName: string;
  shortName: string;
  universityName: string;
  addressLines: string[];
  phones: SitePhone[];
  email: string;
  mapUrl?: string | null;
  social: Partial<Record<SocialNetwork, string>>;
  aboutImageUrl?: string | null;
  aboutImageAlt?: string | null;
}

export const MAX_ADDRESS_LINES = 6;
export const MAX_PHONES = 4;
export const TEL_PATTERN = /^\+?[0-9]{6,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    // The API also requires a top-level domain (https://localhost is rejected)
    return url.protocol === 'https:' && /\.[a-z]{2,}$/i.test(url.hostname) && value.trim().length <= 2048;
  } catch {
    return false;
  }
}

export const EMPTY_SITE_INFO: SiteInfo = {
  organisationName: '',
  shortName: '',
  universityName: '',
  addressLines: [''],
  phones: [{ display: '', tel: '' }],
  email: '',
  mapUrl: '',
  social: {},
  aboutImageUrl: null,
  aboutImageAlt: ''
};

/** Normalises an API response into a complete SiteInfo object. */
export function siteInfoFrom(data: unknown): SiteInfo {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const social = record.social && typeof record.social === 'object' ? (record.social as Record<string, unknown>) : {};
  return {
    organisationName: str(record.organisationName),
    shortName: str(record.shortName),
    universityName: str(record.universityName),
    addressLines: Array.isArray(record.addressLines) ? record.addressLines.map(str) : [],
    phones: Array.isArray(record.phones)
      ? record.phones.map((p) => ({ display: str((p as SitePhone)?.display), tel: str((p as SitePhone)?.tel) }))
      : [],
    email: str(record.email),
    mapUrl: str(record.mapUrl),
    social: Object.fromEntries(SOCIAL_NETWORKS.map((key) => [key, str(social[key])]).filter(([, value]) => value)),
    aboutImageUrl: str(record.aboutImageUrl) || null,
    aboutImageAlt: str(record.aboutImageAlt)
  };
}

/** Trims every value and drops empty optional entries, producing the body for PUT site-info. */
export function siteInfoPayload(info: SiteInfo): SiteInfo {
  const social = Object.fromEntries(
    SOCIAL_NETWORKS.map((key) => [key, (info.social[key] ?? '').trim()]).filter(([, value]) => value)
  ) as SiteInfo['social'];
  return {
    organisationName: info.organisationName.trim(),
    shortName: info.shortName.trim(),
    universityName: info.universityName.trim(),
    addressLines: info.addressLines.map((line) => line.trim()).filter(Boolean),
    phones: info.phones
      .map((p) => ({ display: p.display.trim(), tel: p.tel.replace(/[\s-]/g, '') }))
      .filter((p) => p.display || p.tel),
    email: info.email.trim(),
    mapUrl: info.mapUrl?.trim() ? info.mapUrl.trim() : null,
    social,
    aboutImageUrl: info.aboutImageUrl || null,
    aboutImageAlt: info.aboutImageAlt?.trim() ? info.aboutImageAlt.trim() : null
  };
}

/**
 * Mirrors the API validation: required names, email format, telephone format, https links,
 * at most six address lines and four telephone numbers. Keys match the form fields.
 */
export function validateSiteInfo(info: SiteInfo): Record<string, string> {
  const errors: Record<string, string> = {};
  const payload = siteInfoPayload(info);
  if (!payload.organisationName) errors.organisationName = 'Please enter the organisation name.';
  if (!payload.shortName) errors.shortName = 'Please enter the short name.';
  if (!payload.universityName) errors.universityName = 'Please enter the university name.';
  if (payload.addressLines.length === 0) errors.addressLines = 'Please enter at least one address line.';
  if (info.addressLines.length > MAX_ADDRESS_LINES) errors.addressLines = `The address may have at most ${MAX_ADDRESS_LINES} lines.`;
  if (info.phones.length > MAX_PHONES) errors.phones = `At most ${MAX_PHONES} telephone numbers may be listed.`;
  info.phones.forEach((phone, index) => {
    const display = phone.display.trim();
    const tel = phone.tel.replace(/[\s-]/g, '');
    if (!display && !tel) return;
    if (!display) errors[`phones.${index}.display`] = 'Please enter the number as it should be displayed.';
    if (!TEL_PATTERN.test(tel)) {
      errors[`phones.${index}.tel`] = 'Please enter 6 to 15 digits, optionally starting with +, for example +911204806827.';
    }
  });
  if (!EMAIL_PATTERN.test(payload.email)) errors.email = 'Please enter a valid email address.';
  if (payload.mapUrl && !isHttpsUrl(payload.mapUrl)) errors.mapUrl = 'Please enter a complete map link beginning with https://.';
  SOCIAL_NETWORKS.forEach((key) => {
    const value = payload.social[key];
    if (value && !isHttpsUrl(value)) errors[`social.${key}`] = 'Please enter a complete link beginning with https://.';
  });
  if (payload.aboutImageUrl && !payload.aboutImageAlt) {
    errors.aboutImageAlt = 'Please describe the About image for visitors who use screen readers.';
  }
  return errors;
}

// -------------------------------------------------------------
// SESSIONS
// -------------------------------------------------------------
export interface AuthSession {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

/** "Chrome on Windows" from a user agent string; a formal fallback when it is missing or unknown. */
export function summariseUserAgent(userAgent?: string | null): string {
  if (!userAgent) return 'Unknown Device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|node|axios|python|postman/i.test(ua)
              ? 'Command-Line Client'
              : 'Unknown Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

// -------------------------------------------------------------
// CHAMPIONSHIP PAGE MEDIA (hero video, poster, gallery)
// -------------------------------------------------------------
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export const VIDEO_ACCEPT = VIDEO_MIME_TYPES.join(',');
export const VIDEO_TYPES_LABEL = 'MP4 or WebM';
/** EVENT_VIDEO limit enforced by the API by default (UPLOAD_VIDEO_MAX_MB); the API sends the live value. */
export const DEFAULT_VIDEO_MAX_BYTES = 60 * MB;

export const CHAMPIONSHIP_MEDIA_KINDS = ['drone', 'arena', 'event'] as const;
export type ChampionshipMediaKind = (typeof CHAMPIONSHIP_MEDIA_KINDS)[number];
export const CHAMPIONSHIP_MEDIA_KIND_LABELS: Record<ChampionshipMediaKind, string> = {
  drone: 'Drones',
  arena: 'Arena',
  event: 'Event'
};
export const CHAMPIONSHIP_GALLERY_MAX = 40;
export const CHAMPIONSHIP_CAPTION_MAX = 160;

export interface ChampionshipGalleryItem {
  id: string;
  imageUrl: string;
  caption: string;
  kind: ChampionshipMediaKind;
  published: boolean;
}

export interface ChampionshipMedia {
  heroVideoUrl: string | null;
  heroPosterUrl: string | null;
  gallery: ChampionshipGalleryItem[];
  limits?: { galleryMax?: number; captionMax?: number; videoMaxBytes?: number; videoTypes?: string[] };
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** Normalises the API response of GET /cms/admin/championship-media (defensive against partial data). */
export function championshipMediaFrom(data: unknown): ChampionshipMedia {
  const record = data && typeof data === 'object' ? (data as Partial<ChampionshipMedia>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const gallery = Array.isArray(record.gallery)
    ? record.gallery
        .filter((g): g is ChampionshipGalleryItem => !!g && typeof g.id === 'string' && typeof g.imageUrl === 'string')
        .map((g) => ({
          id: g.id,
          imageUrl: g.imageUrl,
          caption: typeof g.caption === 'string' ? g.caption : '',
          kind: (CHAMPIONSHIP_MEDIA_KINDS as readonly string[]).includes(g.kind) ? g.kind : 'event',
          published: g.published !== false
        }))
    : [];
  return {
    heroVideoUrl: str(record.heroVideoUrl),
    heroPosterUrl: str(record.heroPosterUrl),
    gallery,
    limits: record.limits && typeof record.limits === 'object' ? record.limits : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : null
  };
}

/** Client-side check of a hero video before upload: MP4 / WebM and at most `maxBytes`. */
export function validateVideoFile(file: { name: string; type: string; size: number }, maxBytes: number = DEFAULT_VIDEO_MAX_BYTES): string | null {
  const byName = /\.(mp4|m4v|webm)$/i.test(file.name);
  const typeOk = (VIDEO_MIME_TYPES as readonly string[]).includes(file.type) || (!file.type && byName);
  if (!typeOk) return `${file.name} is not a supported video. Please choose an ${VIDEO_TYPES_LABEL} file.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > maxBytes) return `${file.name} is ${formatBytes(file.size)}. The largest accepted video is ${formatBytes(maxBytes)}.`;
  return null;
}

export function validateChampionshipCaption(caption: string, max: number = CHAMPIONSHIP_CAPTION_MAX): string | null {
  return caption.trim().length > max ? `The caption must be ${max} characters or fewer.` : null;
}

// -------------------------------------------------------------
// ROLE ACCESS
// -------------------------------------------------------------
/** Roles that may open each console tab, mirroring the API RolesGuard on the endpoints each tab uses. */
export const TAB_ROLES: Record<string, readonly string[]> = {
  overview: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  cms_hero: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  home_sections: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  sponsors: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  gallery: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  championship_media: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  site_info: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  registrations: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  scrutineering: ['SUPER_ADMIN', 'EVENT_ADMIN', 'INSPECTOR'],
  scoring: ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE'],
  audit: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  users: ['SUPER_ADMIN'],
  prizes: ['SUPER_ADMIN', 'EVENT_ADMIN'],
  security: ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']
};

export function canOpenTab(tab: string, role?: string | null): boolean {
  return !!role && (TAB_ROLES[tab] ?? []).includes(role);
}

/** Content changes (sponsors, gallery, site information): both administrator roles, per the API. */
export function canManageSiteContent(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';
}

/** Deleting sponsors and gallery images: both administrator roles, with a step-up confirmation. */
export function canDeleteSiteContent(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';
}
