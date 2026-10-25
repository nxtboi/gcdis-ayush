import * as net from 'net';

/**
 * Optional IP allow-list for the staff console (ADMIN_IP_ALLOWLIST).
 *
 * Comma-separated IPv4/IPv6 addresses and CIDR ranges, e.g. "203.0.113.10, 10.0.0.0/8, 2001:db8::/32".
 * Empty or unset = disabled (every address allowed). When the variable is set but contains no valid
 * entry, the list fails closed and denies every address (a typo must never silently disable it).
 * Enforced for staff sign-in, staff session issue/refresh and every admin-audience request.
 */

interface ParsedAllowList {
  enabled: boolean;
  list: net.BlockList | null;
  invalid: string[];
}

let cache: { raw: string; parsed: ParsedAllowList } | null = null;

/** Strips an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) and IPv6 zone ids. */
export function normaliseIp(value: string | undefined | null): string {
  let ip = String(value ?? '').trim();
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  return ip;
}

export function parseIpAllowList(raw: string | undefined | null): ParsedAllowList {
  const text = String(raw ?? '').trim();
  if (!text) return { enabled: false, list: null, invalid: [] };

  const list = new net.BlockList();
  const invalid: string[] = [];
  for (const entryRaw of text.split(',')) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const [addrRaw, prefixRaw, ...rest] = entry.split('/');
    const addr = normaliseIp(addrRaw);
    const family = net.isIP(addr);
    if (!family || rest.length > 0) {
      invalid.push(entry);
      continue;
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefixRaw === undefined) {
      list.addAddress(addr, type);
      continue;
    }
    const prefix = Number(prefixRaw);
    const max = family === 4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefixRaw) || prefix < 0 || prefix > max) {
      invalid.push(entry);
      continue;
    }
    list.addSubnet(addr, prefix, type);
  }
  // Fail closed: configured but with no usable entry -> an empty BlockList that matches nothing
  return { enabled: true, list, invalid };
}

function currentAllowList(env: NodeJS.ProcessEnv = process.env): ParsedAllowList {
  const raw = env.ADMIN_IP_ALLOWLIST ?? '';
  if (cache && cache.raw === raw) return cache.parsed;
  const parsed = parseIpAllowList(raw);
  if (parsed.invalid.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[GCDIS Security] ADMIN_IP_ALLOWLIST ignores invalid entries: ${parsed.invalid.join(', ')}`);
  }
  cache = { raw, parsed };
  return parsed;
}

export function isAdminIpAllowListEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentAllowList(env).enabled;
}

/** True when the allow-list is disabled or the address matches one of its entries. */
export function isAdminIpAllowed(ip: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const parsed = currentAllowList(env);
  if (!parsed.enabled) return true;
  const addr = normaliseIp(ip);
  const family = net.isIP(addr);
  if (!family || !parsed.list) return false;
  return parsed.list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** Client address of an Express request (honours the configured 'trust proxy'). */
export function requestIp(req: any): string {
  return String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
}
