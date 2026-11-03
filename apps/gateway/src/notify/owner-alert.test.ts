import { describe, expect, it, vi } from 'vitest';

import { createOwnerAlert } from './owner-alert';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const options = {
  apiKey: 'secret-resend-key',
  from: 'Twring alerts <alerts@saasage.in>',
  to: 'owner@example.com',
};

describe('createOwnerAlert', () => {
  it('emails the owner through Resend with the subject and text', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await createOwnerAlert({ ...options, fetch: send, log: log() })('Busy day', 'Details');
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: options.from,
      to: ['owner@example.com'],
      subject: 'Busy day',
      text: 'Details',
    });
  });

  it('sends one email per subject per UTC day', async () => {
    let now = Date.parse('2026-10-21T10:00:00Z');
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const alert = createOwnerAlert({ ...options, fetch: send, log: log(), now: () => now });
    await alert('Busy day', 'a');
    await alert('Busy day', 'b');
    await alert('Disk filling', 'c');
    expect(send).toHaveBeenCalledTimes(2);
    now = Date.parse('2026-10-22T01:00:00Z');
    await alert('Busy day', 'd');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('tries again on the next trigger after a failed send, then stops once one is sent', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const alert = createOwnerAlert({ ...options, fetch: send, log: log() });
    await alert('Busy day', 'a');
    await alert('Busy day', 'b');
    await alert('Busy day', 'c');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows a failed send', async () => {
    const logger = log();
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error('network'));
    await expect(
      createOwnerAlert({ ...options, fetch: failing, log: logger })('Busy day', 'x'),
    ).resolves.toBeUndefined();
    const refused = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    await createOwnerAlert({ ...options, fetch: refused, log: logger })('Busy day', 'x');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('createOwnerAlert repeatAfterMs (review: a second outage the same day)', () => {
  it('sends the same subject again once the repeat time has passed', async () => {
    let now = Date.parse('2026-10-21T09:00:00Z');
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const alert = createOwnerAlert({ ...options, fetch: send, log: log(), now: () => now });
    await alert('Twring: calls failing', 'x', { repeatAfterMs: 60 * 60_000 });
    now += 30 * 60_000;
    await alert('Twring: calls failing', 'x', { repeatAfterMs: 60 * 60_000 });
    expect(send).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    await alert('Twring: calls failing', 'x', { repeatAfterMs: 60 * 60_000 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
