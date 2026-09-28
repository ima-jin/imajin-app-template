/**
 * In-memory rate limiter for the operator `/claim` page's `/api/claim`
 * route (#2427). Deliberately in-process only — this app runs as a single
 * pm2 process, and the claim code itself is single-use and short-TTL
 * kernel-side regardless, so this only needs to blunt local brute-force
 * guessing, not survive a restart or coordinate across replicas.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;

const attemptsByKey = new Map<string, number[]>();

function recentAttempts(key: string, now: number): number[] {
  const timestamps = attemptsByKey.get(key) ?? [];
  return timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
}

/** True when `key` has already made `MAX_ATTEMPTS_PER_WINDOW` attempts within the current window. */
export function isRateLimited(key: string): boolean {
  return recentAttempts(key, Date.now()).length >= MAX_ATTEMPTS_PER_WINDOW;
}

/** Records an attempt for `key`, pruning timestamps outside the current window. */
export function recordAttempt(key: string): void {
  const now = Date.now();
  const timestamps = recentAttempts(key, now);
  timestamps.push(now);
  attemptsByKey.set(key, timestamps);
}

/** Test-only: clears all recorded attempts. */
export function resetClaimRateLimitForTests(): void {
  attemptsByKey.clear();
}
