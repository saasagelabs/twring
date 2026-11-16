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
});
