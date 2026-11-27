import type { SpeakerLanguage } from '@twring/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Pending = { resolve: (language: SpeakerLanguage) => void };
const gets: Pending[] = [];
const puts: Pending[] = [];
let serverChanged: (() => void) | undefined;

vi.mock('@/api', () => ({
  twringApi: () => ({
    getLanguage: () => new Promise<SpeakerLanguage>((resolve) => gets.push({ resolve })),
    setLanguage: () => new Promise<SpeakerLanguage>((resolve) => puts.push({ resolve })),
  }),
}));
vi.mock('@/servers/active', () => ({
  onActiveServerChanged: (listener: () => void) => {
    serverChanged = listener;
    return () => undefined;
  },
}));

type Auth = { status: 'signed_in'; userId: string } | { status: 'signed_out' };
let auth: Auth = { status: 'signed_in', userId: 'user-a' };
const authListeners = new Set<() => void>();
function signIn(next: Auth) {
  auth = next;
  authListeners.forEach((listener) => listener());
}
vi.mock('@/auth', () => ({
  authController: () => ({
    getState: () => auth,
    subscribe: (listener: () => void) => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  }),
}));

let foreground: (() => void) | undefined;
vi.mock('@/hooks/foreground', () => ({
  onForeground: (listener: () => void) => {
    foreground = listener;
    return () => undefined;
  },
}));

const { languageStore } = await import('./store');

beforeEach(async () => {
  puts.length = 0;
  languageStore.reset();
  for (const pending of gets.splice(0)) pending.resolve('en');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('language store across a server change', () => {
  it('ignores an answer from the previous server and asks the new one', async () => {
    const first = languageStore.load(true);
    serverChanged!();
    gets[0].resolve('hi');
    await first;
    expect(languageStore.get()).toEqual({ status: 'unknown' });
    // The new server is asked for its own setting.
    expect(gets).toHaveLength(2);
    gets[1].resolve('es');
    await Promise.resolve();
    await Promise.resolve();
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'es' });
  });

  it('ignores a save that finishes after the server changed', async () => {
    const saving = languageStore.save('hi');
    serverChanged!();
    puts[0].resolve('hi');
    await saving;
    expect(languageStore.get()).not.toEqual({ status: 'loaded', language: 'hi' });
  });

  it('publishes a save on the same server', async () => {
    const saving = languageStore.save('de');
    puts[0].resolve('de');
    await expect(saving).resolves.toBe('de');
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'de' });
  });

  it('keeps a saved language when an older read finishes after the save', async () => {
    const reading = languageStore.load(true);
    const saving = languageStore.save('de');
    puts[0].resolve('de');
    await saving;
    gets[0].resolve('hi');
    await reading;
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'de' });
  });
});

describe('language store across an account change', () => {
  it("forgets one account's language when another signs in on the same server", async () => {
    const first = languageStore.load(true);
    gets.at(-1)!.resolve('hi');
    await first;
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'hi' });

    signIn({ status: 'signed_out' });
    expect(languageStore.get()).toEqual({ status: 'unknown' });
    signIn({ status: 'signed_in', userId: 'user-b' });
    gets.at(-1)!.resolve('es');
    await Promise.resolve();
    await Promise.resolve();
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'es' });
  });

  it('keeps the language when the same account refreshes its session', async () => {
    signIn({ status: 'signed_in', userId: 'user-a' });
    const first = languageStore.load(true);
    gets.at(-1)!.resolve('de');
    await first;
    const asked = gets.length;
    signIn({ status: 'signed_in', userId: 'user-a' });
    expect(languageStore.get()).toEqual({ status: 'loaded', language: 'de' });
    expect(gets).toHaveLength(asked);
  });
});

describe('languageStore on return to the app', () => {
  it('re-reads the language, at most once a minute', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      void languageStore.load(true);
      gets.splice(0).forEach((get) => get.resolve('en'));
      await Promise.resolve();
      expect(foreground).toBeDefined();
      foreground?.();
      expect(gets).toHaveLength(1);
      gets.splice(0).forEach((get) => get.resolve('es'));
      await Promise.resolve();
      await Promise.resolve();
      expect(languageStore.get()).toEqual({ status: 'loaded', language: 'es' });
      foreground?.();
      expect(gets).toHaveLength(0);
      vi.setSystemTime(1_000_000 + 61_000);
      foreground?.();
      expect(gets).toHaveLength(1);
    } finally {
      gets.splice(0).forEach((get) => get.resolve('en'));
      vi.useRealTimers();
    }
  });
});
