import { describe, expect, it } from 'vitest';

import { MemoryCollection } from '../store/collection';

import { RingSettingsRepository } from './store';

describe('ring settings: call transcripts (ADR-050)', () => {
  it('defaults to off, and a PUT without it keeps the stored value', async () => {
    const settings = new RingSettingsRepository(new MemoryCollection());
    expect((await settings.get('u1')).call_transcripts).toBe(false);
    await settings.put('u1', { dnd: false, quiet_hours: null, call_transcripts: true });
    // An older app changing Do Not Disturb never sends it.
    await settings.put('u1', { dnd: true, quiet_hours: null });
    expect(await settings.get('u1')).toMatchObject({ dnd: true, call_transcripts: true });
    await settings.put('u1', { dnd: true, quiet_hours: null, call_transcripts: false });
    expect((await settings.get('u1')).call_transcripts).toBe(false);
  });
});
