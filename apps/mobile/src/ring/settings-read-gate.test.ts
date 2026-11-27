import { describe, expect, it } from 'vitest';

import { createSettingsReadGate, formFromSettings, sameForm } from './settings';

describe('createSettingsReadGate', () => {
  it('applies a read when no save happened', () => {
    const gate = createSettingsReadGate();
    expect(gate.issueRead()()).toBe(true);
  });

  it('drops a read that answers while a save is in flight', () => {
    const gate = createSettingsReadGate();
    const canApply = gate.issueRead();
    gate.saveStarted();
    expect(canApply()).toBe(false);
  });

  it('drops a read issued before a save that has since finished', () => {
    const gate = createSettingsReadGate();
    const canApply = gate.issueRead();
    gate.saveStarted();
    gate.saveEnded();
    expect(canApply()).toBe(false);
  });

  it('applies a read issued after the save finished', () => {
    const gate = createSettingsReadGate();
    gate.saveStarted();
    gate.saveEnded();
    expect(gate.issueRead()()).toBe(true);
  });
});

describe('sameForm', () => {
  const settings = {
    dnd: false,
    quiet_hours: { enabled: true, start: '22:00', end: '07:00', time_zone: 'Asia/Kolkata' },
  } as unknown as Parameters<typeof formFromSettings>[0];

  it('an untouched form equals the one it was filled from', () => {
    expect(sameForm(formFromSettings(settings), formFromSettings(settings))).toBe(true);
  });

  it('typed hours count as unsaved edits', () => {
    expect(
      sameForm({ ...formFromSettings(settings), start: '23:00' }, formFromSettings(settings)),
    ).toBe(false);
  });
});
