import { describe, expect, it, vi } from 'vitest';

import { createResendNotifier, createResendSender, signupEmail, type NewSignup } from './notify';

const signup: NewSignup = {
  email: 'person@example.com',
  source: 'beta',
  createdAt: '2026-10-14T10:00:00.000Z',
  total: 7,
};

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const options = {
  apiKey: 'secret-resend-key',
  from: 'Twring alerts <alerts@saasage.in>',
  to: 'support@twring.com',
};

describe('signupEmail', () => {
  it('formats a beta request', () => {
    expect(signupEmail(signup)).toEqual({
      subject: 'New Twring beta request: person@example.com',
      text: `Someone asked for Twring beta access.

Email: person@example.com
Source: twring.com/beta
Time: 2026-10-14T10:00:00.000Z (UTC)
Requests in the list: 7

To let them in, ask Claude to add them, or add them with the members command from the operations checkout.
Then send them the invite email.`,
    });
  });

  it('formats a landing page request', () => {
    expect(signupEmail({ ...signup, source: 'landing' }).text).toContain(
      'Source: twring.com landing page',
    );
  });
});

describe('createResendNotifier', () => {
  it('posts the expected request to Resend', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const log = logger();
    await createResendNotifier({ ...options, fetch: send, log })(signup);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer secret-resend-key',
        'Content-Type': 'application/json',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      from: options.from,
      to: [options.to],
      ...signupEmail(signup),
    });
    expect(log.info).toHaveBeenCalledWith({ event: 'waitlist_notify_sent' }, expect.any(String));
  });

  it.each(['response', 'throw'] as const)(
    'resolves and logs safely on %s failure',
    async (kind) => {
      const send = vi.fn<typeof fetch>();
      if (kind === 'response')
        send.mockResolvedValue(new Response('private body', { status: 500 }));
      else send.mockRejectedValue(new Error('private body'));
      const log = logger();
      await expect(
        createResendNotifier({ ...options, fetch: send, log })(signup),
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        kind === 'response'
          ? { event: 'waitlist_notify_failed', status: 500 }
          : { event: 'waitlist_notify_failed' },
        expect.any(String),
      );
      for (const call of [...log.info.mock.calls, ...log.warn.mock.calls]) {
        const line = JSON.stringify(call);
        expect(line).not.toContain(signup.email);
        expect(line).not.toContain(options.apiKey);
        expect(line).not.toContain('private body');
      }
    },
  );

  it('caps sends per hour and allows another after the window', async () => {
    let time = 0;
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const log = logger();
    const notify = createResendNotifier({
      ...options,
      fetch: send,
      log,
      maxPerHour: 2,
      now: () => time,
    });
    await notify(signup);
    await notify(signup);
    await notify(signup);
    expect(send).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ event: 'waitlist_notify_skipped' }, expect.any(String));
    time = 60 * 60_000;
    await notify(signup);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('createResendSender', () => {
  it('sends one email with the reply-to address and reports success', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const send = createResendSender({
      apiKey: 'key',
      from: 'Twring <invites@example.com>',
      fetch: (url, init) => {
        calls.push({
          url: url as string,
          body: JSON.parse(init?.body as string) as Record<string, unknown>,
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    const ok = await send({
      to: 'a@example.com',
      subject: 'S',
      text: 'T',
      replyTo: 'support@example.com',
    });
    expect(ok).toBe('sent');
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.body).toEqual({
      from: 'Twring <invites@example.com>',
      to: ['a@example.com'],
      subject: 'S',
      text: 'T',
      reply_to: 'support@example.com',
    });
  });

  it('a refused or failed send reports false, never throws', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const refused = createResendSender({
      apiKey: 'key',
      from: 'f',
      fetch: () => Promise.resolve(new Response('{}', { status: 429 })),
      log,
    });
    expect(await refused({ to: 'a@example.com', subject: 'S', text: 'T' })).toBe('retry');
    const offline = createResendSender({
      apiKey: 'key',
      from: 'f',
      fetch: () => Promise.reject(new Error('offline')),
      log,
    });
    expect(await offline({ to: 'a@example.com', subject: 'S', text: 'T' })).toBe('retry');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
