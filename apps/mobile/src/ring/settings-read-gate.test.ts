import { describe, expect, it } from 'vitest';

import { createSettingsReadGate } from './settings';

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
