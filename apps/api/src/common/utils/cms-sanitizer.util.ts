import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

/**
 * Strict allow-list for CMS rich text. Anything not listed is removed by a real HTML parser
 * (sanitize-html / htmlparser2), so malformed markup such as `<img/src=x/onerror=...>` or
 * entity-encoded `&#106;avascript:` URLs cannot slip through as they could with regexes.
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark',
    'span', 'blockquote', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'a', 'img'
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {},
  allowVulnerableTags: false,
  // Remove these elements together with their contents
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'title'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const next: Record<string, string> = { ...attribs };
      if (next.target) {
        next.target = '_blank';
        next.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: next };
    }
  }
};

/**
 * Server-side HTML and Rich Text Sanitizer (allow-list based, parser backed).
 * Plain text without any markup is returned unchanged so it is not entity-encoded twice when
 * rendered as text by the frontend.
 */
export function sanitizeRichText(html: string): string {
  if (!html || typeof html !== 'string') return '';
  // No '<' means no element can be created when inserted as HTML; keep plain text verbatim.
  if (!html.includes('<')) return html;
  return sanitizeHtml(html, RICH_TEXT_OPTIONS);
}

/**
 * Validates and sanitizes a URL.
 * Only allows http:, https:, mailto: or same-origin relative /... paths.
 */
export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();

  // Control characters / whitespace inside URLs are used to smuggle schemes past parsers
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) {
    throw new BadRequestException('Invalid URL: control or whitespace characters are not permitted.');
  }

  // Allow same-origin relative URLs starting with a single '/' ('//' and '/\' are protocol-relative in browsers)
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return trimmed;
    }
  } catch {
    // Malformed URL
  }

  throw new BadRequestException(`Invalid or disallowed URL protocol: '${url}'. Only HTTP/HTTPS, mailto and internal relative paths are permitted.`);
}

export interface BackgroundSettings {
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'color';
  focusX?: number;
  focusY?: number;
  zoom?: number;
  overlayColor?: string;
  overlayOpacity?: number;
  blurPx?: number;
  brightnessPct?: number;
  parallaxEnabled?: boolean;
  mobileCropFocusY?: number;
}

/**
 * Validates CMS background customization parameters:
 * - focusX: 0-100
 * - focusY: 0-100
 * - mobileCropFocusY: 0-100
 * - zoom: 100-200% (or 1.0-2.0)
 * - overlayOpacity: 0.0-1.0
 * - blurPx: 0-20 (capped at 20)
 * - brightnessPct: 0-200 (capped at 200)
 * - overlayColor: hex color
 */
export function validateBackgroundSettings(config: BackgroundSettings): void {
  if (!config || typeof config !== 'object') return;

  if (config.mediaUrl) {
    sanitizeUrl(config.mediaUrl);
  }

  if (config.focusX !== undefined && config.focusX !== null) {
    if (typeof config.focusX !== 'number' || config.focusX < 0 || config.focusX > 100) {
      throw new BadRequestException('focusX must be a number between 0 and 100');
    }
  }

  if (config.focusY !== undefined && config.focusY !== null) {
    if (typeof config.focusY !== 'number' || config.focusY < 0 || config.focusY > 100) {
      throw new BadRequestException('focusY must be a number between 0 and 100');
    }
  }

  if (config.mobileCropFocusY !== undefined && config.mobileCropFocusY !== null) {
    if (typeof config.mobileCropFocusY !== 'number' || config.mobileCropFocusY < 0 || config.mobileCropFocusY > 100) {
      throw new BadRequestException('mobileCropFocusY must be a number between 0 and 100');
    }
  }

  if (config.zoom !== undefined && config.zoom !== null) {
    // Zoom can be 1.0-2.0 or 100-200%
    if (typeof config.zoom !== 'number' || config.zoom < 1 || config.zoom > 200) {
      throw new BadRequestException('zoom must be between 100% and 200% (or 1.0 - 2.0)');
    }
  }

  if (config.overlayOpacity !== undefined && config.overlayOpacity !== null) {
    if (typeof config.overlayOpacity !== 'number' || config.overlayOpacity < 0 || config.overlayOpacity > 1) {
      throw new BadRequestException('overlayOpacity must be a decimal between 0.0 and 1.0');
    }
  }

  if (config.blurPx !== undefined && config.blurPx !== null) {
    if (typeof config.blurPx !== 'number' || config.blurPx < 0 || config.blurPx > 20) {
      throw new BadRequestException('blurPx must be between 0 and 20px');
    }
  }

  if (config.brightnessPct !== undefined && config.brightnessPct !== null) {
    if (typeof config.brightnessPct !== 'number' || config.brightnessPct < 0 || config.brightnessPct > 200) {
      throw new BadRequestException('brightnessPct must be between 0% and 200%');
    }
  }

  if (config.overlayColor !== undefined && config.overlayColor !== null) {
    const hexRegex = /^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/;
    if (typeof config.overlayColor !== 'string' || !hexRegex.test(config.overlayColor)) {
      throw new BadRequestException('overlayColor must be a valid hex color string (e.g. #000000 or #1a1a2e)');
    }
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CONTENT_DEPTH = 32;

/**
 * Deep-sanitizes all strings in an arbitrary object or array
 */
export function deepSanitizeContent(data: any, depth: number = 0): any {
  if (data === null || data === undefined) return data;

  if (depth > MAX_CONTENT_DEPTH) {
    throw new BadRequestException('Content structure is nested too deeply');
  }

  if (typeof data === 'string') {
    return sanitizeRichText(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => deepSanitizeContent(item, depth + 1));
  }

  if (typeof data === 'object') {
    const sanitizedObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      if (key === 'background' || key === 'heroBackground' || key === 'backgroundSettings') {
        validateBackgroundSettings(value as BackgroundSettings);
        sanitizedObj[key] = deepSanitizeContent(value, depth + 1);
      } else if (key.toLowerCase().endsWith('url') && typeof value === 'string') {
        sanitizedObj[key] = sanitizeUrl(value);
      } else {
        sanitizedObj[key] = deepSanitizeContent(value, depth + 1);
      }
    }
    return sanitizedObj;
  }

  return data;
}

/**
 * Plain-text hero copy fields (QA M5) and their maximum lengths (characters, after sanitisation).
 * Stored inside the hero section's `data` object alongside the background settings.
 */
export const HERO_TEXT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  headline: 200,
  description: 600,
  tagline: 120,
  announcementTitle: 160,
  announcementDate: 60,
  announcementBody: 1000
});

const PLAIN_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'title'],
  disallowedTagsMode: 'discard'
};

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Converts input to plain text: removes all markup, control characters (newlines and tabs are kept)
 * and any leftover angle brackets. Throws 400 if the value is not a string or exceeds maxLength.
 */
export function sanitizePlainText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  let text = value;
  if (text.includes('<') || text.includes('&')) {
    text = decodeBasicEntities(sanitizeHtml(text, PLAIN_TEXT_OPTIONS));
  }
  text = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[<>]/g, '');
  if (text.length > maxLength) {
    throw new BadRequestException(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

/**
 * Sanitises the plain-text hero copy fields in-place on a hero `data` object (top level and the
 * legacy nested `background` object). Absent fields are left absent; null clears the field.
 */
export function sanitizeHeroTextFields<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out: Record<string, any> = { ...data };
  for (const [field, max] of Object.entries(HERO_TEXT_LIMITS)) {
    if (!(field in out) || out[field] === undefined) continue;
    if (out[field] === null) {
      out[field] = '';
      continue;
    }
    out[field] = sanitizePlainText(out[field], max, field);
  }
  return out as T;
}
