/**
 * Resolves Express 'trust proxy' from TRUST_PROXY (QA L8).
 * Accepts: 'true'/'false', a hop count ('1', '2'), or a comma-separated list of trusted
 * addresses/subnets ('loopback', '10.0.0.0/8'). Default: 1 in production (behind Nginx), false otherwise.
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = (env.TRUST_PROXY ?? '').trim();
  if (raw === '') return env.NODE_ENV === 'production' ? 1 : false;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false' || lower === '0') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
