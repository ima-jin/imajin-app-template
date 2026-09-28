import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRateLimited, recordAttempt, resetClaimRateLimitForTests } from '../claim-rate-limit';

const ATTEMPT_LIMIT = 5;

describe('claim rate limiting', () => {
  afterEach(() => {
    resetClaimRateLimitForTests();
    vi.useRealTimers();
  });

  it('allows attempts under the limit', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT - 1; attempt += 1) {
      expect(isRateLimited('1.2.3.4')).toBe(false);
      recordAttempt('1.2.3.4');
    }
  });

  it('blocks once the limit is reached', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }

    expect(isRateLimited('1.2.3.4')).toBe(true);
  });

  it('tracks separate keys independently', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }

    expect(isRateLimited('5.6.7.8')).toBe(false);
  });

  it('forgets attempts once the window elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }
    expect(isRateLimited('1.2.3.4')).toBe(true);

    vi.setSystemTime(20 * 60 * 1000);

    expect(isRateLimited('1.2.3.4')).toBe(false);
  });
});
