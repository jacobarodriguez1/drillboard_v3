// lib/rateLimit.ts
// In-memory rate limiter for login. Resets on server restart.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const store = new Map<string, { count: number; resetAt: number }>();

function prune() {
  const now = Date.now();
  for (const [key, v] of store.entries()) {
    if (v.resetAt < now) store.delete(key);
  }
}

/** Returns true if allowed, false if rate limited. */
export function checkLoginRateLimit(ip: string): boolean {
  prune();
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry) return true;
  if (entry.resetAt < now) {
    store.delete(ip);
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

/** Record a failed attempt. Call after invalid password. */
export function recordFailedAttempt(ip: string): void {
  prune();
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (entry.resetAt < now) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}
