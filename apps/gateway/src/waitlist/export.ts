import { z } from 'zod';

import { waitlistRecordSchema } from './routes';

export interface SignupExportOptions {
  source?: 'landing' | 'beta' | 'app';
  includeInternal?: boolean;
}

export interface SignupExport {
  csv: string;
  counts: {
    exported: number;
    beta: number;
    landing: number;
    app: number;
    skippedInternal: number;
    skippedFiltered: number;
  };
}

export const INTERNAL_EMAIL_DOMAINS: readonly string[] = ['twring.com'];

export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[,"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function signupsCsv(input: unknown, options: SignupExportOptions = {}): SignupExport {
  const parsed = z.array(waitlistRecordSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error('waitlist.json is not a list of signups');
  }

  const counts = {
    exported: 0,
    beta: 0,
    landing: 0,
    app: 0,
    skippedInternal: 0,
    skippedFiltered: 0,
  };
  const rows: (typeof parsed.data)[number][] = [];
  for (const record of parsed.data) {
    const domain = record.email.slice(record.email.lastIndexOf('@') + 1).toLowerCase();
    if (!options.includeInternal && INTERNAL_EMAIL_DOMAINS.includes(domain)) {
      counts.skippedInternal++;
    } else if (options.source !== undefined && record.source !== options.source) {
      counts.skippedFiltered++;
    } else {
      rows.push(record);
      counts[record.source]++;
    }
  }

  rows.sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      (a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
  );
  counts.exported = rows.length;

  const lines = [
    'email,signed_up_at,source',
    ...rows.map((record) =>
      [record.email, record.created_at, record.source].map(csvField).join(','),
    ),
  ];
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, counts };
}
