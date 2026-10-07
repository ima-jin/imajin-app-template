// Pure checks behind scripts/check-registry-deps.mjs — no I/O, unit-tested in
// scripts/lib/__tests__/registry-deps-check.test.ts.
//
// An app consumes @ima-jin/* (and everything else) from the published npm
// registry, exactly like any outside party (AGENTS.md §2). It must never
// resolve a dependency through a monorepo workspace link, a local path, or a
// tarball/git URL — those only work inside a checkout that is not this repo.

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// Specifier prefixes that do not come from the registry.
const NON_REGISTRY_SPEC = /^(?:workspace:|link:|file:|portal:|git\+|git:|github:|https?:|\.{1,2}\/|\/)/;
// Prefixes of a lockfile `specifier:`/`version:` value that do not come from the registry.
const LOCKFILE_SPEC_PREFIXES = ['workspace:', 'link:', 'file:', 'portal:'];
// Keys inside a lockfile `resolution: {…}` flow map that mean a non-registry resolution.
const LOCKFILE_RESOLUTION_KEYS = ['tarball:', 'directory:', 'type: git', 'repo:'];
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

/** Errors for package.json: non-registry specifiers and the unpublished monorepo scope. */
export function checkPackageJson(pkg) {
  const errors = [];
  const specs = [];
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) specs.push([`${field}.${name}`, name, spec]);
  }
  for (const [name, spec] of Object.entries(pkg.pnpm?.overrides ?? {})) specs.push([`pnpm.overrides.${name}`, name, spec]);

  for (const [where, name, spec] of specs) {
    if (typeof spec === 'string' && NON_REGISTRY_SPEC.test(spec)) {
      errors.push(`package.json ${where}: "${spec}" is not resolved from the npm registry`);
    }
    if (name.startsWith('@imajin/')) {
      errors.push(`package.json ${where}: @imajin/* is the monorepo's internal scope and is not published — use the published @ima-jin/* packages`);
    }
  }
  return errors;
}

function lockfileValue(trimmed, key) {
  if (!trimmed.startsWith(key)) return null;
  return trimmed.slice(key.length).trim().replace(/^['"]/, '');
}

function isNonRegistrySpecLine(trimmed) {
  const value = lockfileValue(trimmed, 'specifier:') ?? lockfileValue(trimmed, 'version:');
  return value !== null && LOCKFILE_SPEC_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isNonRegistryResolutionLine(trimmed) {
  return trimmed.includes('resolution:') && LOCKFILE_RESOLUTION_KEYS.some((key) => trimmed.includes(key));
}

/** Errors for pnpm-lock.yaml text (line-based: no backtracking regexes over untrusted-size input). */
export function checkLockfile(text) {
  const errors = [];
  const lines = text.split('\n').map((line) => line.trim());
  if (lines.some(isNonRegistrySpecLine)) {
    errors.push('pnpm-lock.yaml contains a workspace/link/file/portal specifier');
  }
  if (lines.some(isNonRegistryResolutionLine)) {
    errors.push('pnpm-lock.yaml contains a tarball/git/directory resolution (not the npm registry)');
  }
  return errors;
}

/** Errors for an .npmrc (pass null when the file does not exist). */
export function checkNpmrc(text) {
  if (text === null) return [];
  const errors = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (/_authToken|_auth\b|_password/.test(line)) {
      errors.push('.npmrc contains credentials — no secrets in the repo');
    }
    const registry = /^(?:@[\w-]+:)?registry\s*=\s*(\S+)/.exec(line);
    if (registry !== null && registry[1] !== OFFICIAL_REGISTRY) {
      errors.push(`.npmrc redirects a registry to ${registry[1]} — consume from ${OFFICIAL_REGISTRY}`);
    }
  }
  return errors;
}

/** After install: a package must resolve into pnpm's content-addressed store, not a link out of the tree. */
export function isInstalledFromStore(realPath) {
  return realPath.replaceAll('\\', '/').includes('/node_modules/.pnpm/');
}
