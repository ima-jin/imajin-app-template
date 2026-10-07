import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import { APP_SLUG } from '../app-slug';

describe('APP_SLUG', () => {
  it('is the package name, which the fork rename step sets to the registry slug', () => {
    expect(APP_SLUG).toBe(pkg.name);
  });

  it('is slug-shaped — never a host or URL (imajin-ai#2706)', () => {
    expect(APP_SLUG).toMatch(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
  });
});
