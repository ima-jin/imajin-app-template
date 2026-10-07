// Pure helpers for scripts/audit-gate.mjs — no I/O, no process control, so they
// are unit-testable (scripts/lib/__tests__/audit-gate-core.test.ts).

/** Compare strings deterministically (never rely on the default sort). */
export const byString = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * Decode a report buffer, honouring a byte-order mark. bash writes UTF-8 but
 * PowerShell 5.1's `>` writes UTF-16LE; decoding by BOM keeps the documented
 * command working on a Windows dev box too.
 */
export function decodeReport(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: node has no decoder, so byte-swap into LE first.
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** Prefer the GHSA id (stable, what GitHub links to); fall back to CVE, then npm id. */
export function advisoryId(advisory) {
  const refs = advisory.references ?? '';
  for (const line of refs.split('\n')) {
    if (line.includes('github.com/advisories/GHSA-') || line.includes('/security/advisories/GHSA-')) {
      return line.slice(line.lastIndexOf('/') + 1).trim();
    }
  }
  return advisory.cves?.[0] ?? `npm-${advisory.id}`;
}

/** Collect the high/critical advisories of a `pnpm audit --json` report, keyed by id. */
export function collectFindings(report) {
  const found = new Map();
  for (const advisory of Object.values(report.advisories ?? {})) {
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
    const id = advisoryId(advisory);
    if (!found.has(id)) {
      found.set(id, {
        id,
        module: advisory.module_name,
        severity: advisory.severity,
        title: advisory.title,
        patched: advisory.patched_versions ?? '',
      });
    }
  }
  return found;
}

/** Split findings into those the baseline does not cover and baseline ids that no longer appear. */
export function evaluate(found, baseline) {
  const baselineIds = new Set((baseline.advisories ?? []).map((a) => a.id));
  const introduced = [...found.values()].filter((a) => !baselineIds.has(a.id));
  const resolvedIds = [...baselineIds].filter((id) => !found.has(id));
  return { baselineIds, introduced, resolvedIds };
}

/** Human-readable lines for the advisories a change introduced. */
export function formatIntroduced(introduced) {
  const lines = [];
  const ordered = [...introduced].sort((x, y) => byString(x.module, y.module));
  for (const a of ordered) {
    const fix = a.patched && a.patched !== '<0.0.0' ? `upgrade to ${a.patched}` : 'no fix published';
    lines.push(`  ${a.severity.toUpperCase()}  ${a.module}  ${a.id}`, `         ${a.title}`, `         ${fix}`);
  }
  return lines;
}
