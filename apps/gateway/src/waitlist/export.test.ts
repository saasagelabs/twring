import { describe, expect, it } from 'vitest';

import { csvField, signupsCsv } from './export';

const record = (email: string, created_at: string, source: 'landing' | 'beta') => ({
  email,
  created_at,
  source,
});

describe('signupsCsv', () => {
  it('exports and counts signups that came from the app', () => {
    const result = signupsCsv(
      [
        { email: 'a@example.com', created_at: '2026-10-15T10:00:00.000Z', source: 'app' },
        { email: 'b@example.com', created_at: '2026-10-15T11:00:00.000Z', source: 'beta' },
      ],
      { source: 'app' },
    );
    expect(result.counts).toMatchObject({ exported: 1, app: 1, beta: 0, skippedFiltered: 1 });
    expect(result.csv).toContain('a@example.com,2026-10-15T10:00:00.000Z,app');
  });

  it('exports rows sorted by time and email with a BOM and CRLF line endings', () => {
    const result = signupsCsv([
      record('z@example.com', '2026-10-12T12:00:00.000Z', 'beta'),
      record('b@example.com', '2026-10-12T10:00:00.000Z', 'landing'),
      record('a@example.com', '2026-10-12T12:00:00.000Z', 'beta'),
    ]);

    expect(result.csv).toBe(
      '\uFEFFemail,signed_up_at,source\r\n' +
        'b@example.com,2026-10-12T10:00:00.000Z,landing\r\n' +
        'a@example.com,2026-10-12T12:00:00.000Z,beta\r\n' +
        'z@example.com,2026-10-12T12:00:00.000Z,beta\r\n',
    );
    expect(result.counts).toEqual({
      exported: 3,
      beta: 2,
      landing: 1,
      app: 0,
      skippedInternal: 0,
      skippedFiltered: 0,
    });
  });

  it('filters by source and counts excluded rows', () => {
    const result = signupsCsv(
      [
        record('a@example.com', '2026-10-12T10:00:00.000Z', 'landing'),
        record('b@example.com', '2026-10-12T11:00:00.000Z', 'beta'),
      ],
      { source: 'beta' },
    );

    expect(result.csv).toBe(
      '\uFEFFemail,signed_up_at,source\r\nb@example.com,2026-10-12T11:00:00.000Z,beta\r\n',
    );
    expect(result.counts).toEqual({
      exported: 1,
      beta: 1,
      landing: 0,
      app: 0,
      skippedInternal: 0,
      skippedFiltered: 1,
    });
  });

  it('leaves out internal addresses first unless explicitly included', () => {
    const input = [
      record('test@twring.com', '2026-10-12T10:00:00.000Z', 'landing'),
      record('person@example.com', '2026-10-12T11:00:00.000Z', 'beta'),
    ];
    const normal = signupsCsv(input, { source: 'beta' });
    expect(normal.csv).not.toContain('test@twring.com');
    expect(normal.counts.skippedInternal).toBe(1);
    expect(normal.counts.skippedFiltered).toBe(0);

    const all = signupsCsv(input, { includeInternal: true });
    expect(all.csv).toContain('test@twring.com');
    expect(all.counts).toEqual({
      exported: 2,
      beta: 1,
      landing: 1,
      app: 0,
      skippedInternal: 0,
      skippedFiltered: 0,
    });
  });

  it('protects spreadsheet formulas and applies RFC 4180 quoting', () => {
    expect(csvField('=cmd@x.com')).toBe("'=cmd@x.com");
    expect(csvField('+1@x.com')).toBe("'+1@x.com");
    expect(csvField('-a@x.com')).toBe("'-a@x.com");
    expect(csvField('@x.com')).toBe("'@x.com");
    expect(csvField('\tvalue')).toBe("'\tvalue");
    expect(csvField('\rvalue')).toBe('"\'\rvalue"');
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it.each([
    'not an array',
    [{ created_at: '2026-10-12T10:00:00.000Z', source: 'beta' }],
    [record('secret@example.com', '2026-10-12T10:00:00.000Z', 'other' as 'beta')],
  ])('rejects invalid input with a fixed, data-free message', (input) => {
    expect(() => signupsCsv(input)).toThrowError('waitlist.json is not a list of signups');
    try {
      signupsCsv(input);
    } catch (error) {
      expect((error as Error).message).toBe('waitlist.json is not a list of signups');
      expect((error as Error).message).not.toContain('secret@example.com');
    }
  });

  it('exports an empty list as only the header', () => {
    expect(signupsCsv([])).toEqual({
      csv: '\uFEFFemail,signed_up_at,source\r\n',
      counts: {
        exported: 0,
        beta: 0,
        landing: 0,
        app: 0,
        skippedInternal: 0,
        skippedFiltered: 0,
      },
    });
  });
});
