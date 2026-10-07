import { describe, expect, it } from 'vitest';
import {
  checkLockfile,
  checkNpmrc,
  checkPackageJson,
  isInstalledFromStore,
} from '../registry-deps-check.mjs';

describe('checkPackageJson', () => {
  it('accepts registry semver ranges, including published @ima-jin/*', () => {
    const pkg = { dependencies: { '@ima-jin/auth-client': '^0.8.8', next: '^15.5.24' }, devDependencies: { vitest: '^2' } };
    expect(checkPackageJson(pkg)).toEqual([]);
  });

  it('rejects workspace/link/file/git/url specifiers in any field and in overrides', () => {
    const pkg = {
      dependencies: { a: 'workspace:*', b: 'link:../b' },
      devDependencies: { c: 'file:../c', d: 'git+https://example.com/d.git' },
      optionalDependencies: { e: 'https://example.com/e.tgz' },
      peerDependencies: { f: '../f' },
      pnpm: { overrides: { g: 'github:o/g' } },
    };
    expect(checkPackageJson(pkg)).toHaveLength(7);
  });

  it("rejects the monorepo's unpublished @imajin/* scope", () => {
    const errors = checkPackageJson({ dependencies: { '@imajin/db': '^1.0.0' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('@imajin/*');
  });

  it('ignores a package.json with no dependencies', () => {
    expect(checkPackageJson({})).toEqual([]);
  });
});

describe('checkLockfile', () => {
  it('accepts a registry-only lockfile', () => {
    const text = "importers:\n  .:\n    dependencies:\n      next:\n        specifier: ^15\n        version: 15.5.26\npackages:\n  next@15.5.26:\n    resolution: {integrity: sha512-abc}\n";
    expect(checkLockfile(text)).toEqual([]);
  });

  it('rejects link/workspace importers and tarball/git/directory resolutions', () => {
    expect(checkLockfile('      x:\n        specifier: workspace:*\n        version: link:../x\n')).toHaveLength(1);
    expect(checkLockfile('    resolution: {tarball: https://example.com/x.tgz}')).toHaveLength(1);
    expect(checkLockfile('    resolution: {type: git, repo: https://example.com/x.git, commit: abc}')).toHaveLength(1);
    expect(checkLockfile('    resolution: {directory: ../x, type: directory}')).toHaveLength(1);
  });
});

describe('checkNpmrc', () => {
  it('accepts a missing file, comments and the official registry', () => {
    expect(checkNpmrc(null)).toEqual([]);
    expect(checkNpmrc('# comment\n; other\n\nregistry=https://registry.npmjs.org/\n@ima-jin:registry=https://registry.npmjs.org/\n')).toEqual([]);
  });

  it('rejects registry redirects and credentials', () => {
    expect(checkNpmrc('@ima-jin:registry=https://npm.pkg.github.com\n')[0]).toContain('redirects a registry');
    expect(checkNpmrc('registry=https://example.com/\n')).toHaveLength(1);
    expect(checkNpmrc('//registry.npmjs.org/:_authToken=abc\n')[0]).toContain('credentials');
  });
});

describe('isInstalledFromStore', () => {
  it('is true only for paths inside the pnpm store', () => {
    expect(isInstalledFromStore('/app/node_modules/.pnpm/@ima-jin+auth-client@0.8.8/node_modules/@ima-jin/auth-client')).toBe(true);
    expect(isInstalledFromStore('C:\\app\\node_modules\\.pnpm\\x@1\\node_modules\\x')).toBe(true);
    expect(isInstalledFromStore('/monorepo/packages/auth-client')).toBe(false);
  });
});
