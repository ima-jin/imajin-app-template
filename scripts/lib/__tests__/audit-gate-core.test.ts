import { describe, expect, it } from 'vitest';
import {
  advisoryId,
  byString,
  collectFindings,
  decodeReport,
  evaluate,
  formatIntroduced,
} from '../audit-gate-core.mjs';

const advisory = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  module_name: 'left-pad',
  severity: 'high',
  title: 'Bad things',
  patched_versions: '>=2.0.0',
  references: '- https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  ...overrides,
});

describe('byString', () => {
  it('orders ascending, equal and descending', () => {
    expect(byString('a', 'b')).toBe(-1);
    expect(byString('b', 'a')).toBe(1);
    expect(byString('a', 'a')).toBe(0);
  });
});

describe('decodeReport', () => {
  it('decodes UTF-8, stripping a BOM', () => {
    expect(decodeReport(Buffer.from('\uFEFF{"a":1}', 'utf8'))).toBe('{"a":1}');
  });

  it('decodes UTF-16LE with a BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]);
    expect(decodeReport(buf)).toBe('{"a":1}');
  });

  it('decodes UTF-16BE with a BOM', () => {
    const le = Buffer.from('{"a":1}', 'utf16le');
    le.swap16();
    expect(decodeReport(Buffer.concat([Buffer.from([0xfe, 0xff]), le]))).toBe('{"a":1}');
  });
});

describe('advisoryId', () => {
  it('prefers the GHSA id from github.com/advisories references', () => {
    expect(advisoryId(advisory())).toBe('GHSA-aaaa-bbbb-cccc');
  });

  it('reads a GHSA id from a repo security-advisories URL', () => {
    const refs = '- https://github.com/o/r/security/advisories/GHSA-1111-2222-3333';
    expect(advisoryId(advisory({ references: refs }))).toBe('GHSA-1111-2222-3333');
  });

  it('falls back to the CVE, then the npm advisory id', () => {
    expect(advisoryId(advisory({ references: '', cves: ['CVE-2026-1'] }))).toBe('CVE-2026-1');
    expect(advisoryId(advisory({ references: undefined, id: 42 }))).toBe('npm-42');
  });
});

describe('collectFindings', () => {
  it('keeps only high/critical advisories and de-duplicates by id', () => {
    const report = {
      advisories: {
        1: advisory(),
        2: advisory({ id: 2 }),
        3: advisory({ id: 3, severity: 'moderate', references: '- https://github.com/advisories/GHSA-low' }),
        4: advisory({ id: 4, severity: 'critical', references: '- https://github.com/advisories/GHSA-crit' }),
      },
    };
    const found = collectFindings(report);
    expect([...found.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-crit']);
    expect(found.get('GHSA-crit')?.severity).toBe('critical');
  });

  it('tolerates a report without advisories', () => {
    expect(collectFindings({}).size).toBe(0);
  });
});

describe('evaluate', () => {
  const found = collectFindings({ advisories: { 1: advisory() } });

  it('flags advisories missing from the baseline', () => {
    const { introduced, resolvedIds, baselineIds } = evaluate(found, { advisories: [] });
    expect(introduced.map((a: { id: string }) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(resolvedIds).toEqual([]);
    expect(baselineIds.size).toBe(0);
  });

  it('tolerates baselined advisories and reports resolved ones', () => {
    const baseline = { advisories: [{ id: 'GHSA-aaaa-bbbb-cccc' }, { id: 'GHSA-gone' }] };
    const { introduced, resolvedIds } = evaluate(found, baseline);
    expect(introduced).toEqual([]);
    expect(resolvedIds).toEqual(['GHSA-gone']);
  });

  it('treats a baseline with no advisories key as empty', () => {
    expect(evaluate(found, {}).introduced).toHaveLength(1);
  });
});

describe('formatIntroduced', () => {
  it('sorts by module and states the fix or its absence', () => {
    const lines = formatIntroduced([
      { id: 'GHSA-z', module: 'zeta', severity: 'high', title: 'Z', patched: '<0.0.0' },
      { id: 'GHSA-a', module: 'alpha', severity: 'critical', title: 'A', patched: '>=1.2.3' },
    ]);
    expect(lines[0]).toBe('  CRITICAL  alpha  GHSA-a');
    expect(lines[2]).toBe('         upgrade to >=1.2.3');
    expect(lines[5]).toBe('         no fix published');
  });
});
