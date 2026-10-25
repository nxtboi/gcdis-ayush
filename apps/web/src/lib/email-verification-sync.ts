/**
 * Cross-tab notice that the captain's email address has just been verified: the verification page
 * (usually opened from the email in a new tab) tells any open Team Portal tab to re-read its status,
 * so the dashboard never keeps a stale "unverified" banner until a hard reload.
 * BroadcastChannel where available, with a localStorage "storage" event as the fallback.
 */

const CHANNEL = 'gcdis-portal-auth';
const STORAGE_KEY = 'gcdis.portal.emailVerifiedAt';
const MESSAGE = 'email-verified';

export function announceEmailVerified(): void {
  if (typeof window === 'undefined') return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage(MESSAGE);
      channel.close();
    }
  } catch {
    // Not available (e.g. private mode restrictions): the storage fallback below still runs
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the portal still re-checks on focus
  }
}

/** Calls onVerified when another tab announces a verification. Returns the unsubscribe function. */
export function onEmailVerifiedElsewhere(onVerified: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        if (event.data === MESSAGE) onVerified();
      };
    }
  } catch {
    channel = null;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue) onVerified();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
    try {
      channel?.close();
    } catch {
      // ignore
    }
  };
}
