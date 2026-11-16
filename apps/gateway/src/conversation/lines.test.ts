import { describe, expect, it } from 'vitest';

import { approvalPrompt, approvalVoiceDecision } from './approvals';
import { FLOOR_CONTROL_WORDS, isFloorControl } from './controller';
import { echoWords } from './echo';
import { LINES, STOP_WORDS, type LineLanguage } from './lines';
import { GENERIC_PROGRESS_LINE, ackLine, progressLine } from './presence';

const LANGUAGES = Object.keys(LINES) as LineLanguage[];

describe('Twring lines per language', () => {
  it.each(LANGUAGES)('%s has three distinct acks that are not only stop words', (language) => {
    const { ack } = LINES[language];
    expect(new Set(ack).size).toBe(3);
    const stops = [...FLOOR_CONTROL_WORDS, ...(STOP_WORDS[language] ?? [])];
    for (const line of ack) {
      expect(isFloorControl(echoWords(line), language), line).toBe(false);
      expect(stops.includes(line)).toBe(false);
    }
    for (let n = 0; n < 6; n += 1) expect(ackLine(n + 1, language)).not.toBe(ackLine(n, language));
  });

  it.each(LANGUAGES)('%s names the agent in the approval prompt', (language) => {
    expect(approvalPrompt('Hermes', 'run_command', language)).toContain('Hermes');
  });

  it('keeps English byte-identical and uses the generic progress line elsewhere', () => {
    expect(ackLine(0)).toBe('Okay, one moment.');
    expect(approvalPrompt('Hermes', 'delete_files')).toBe(
      'Hermes wants to delete files. Say yes or no, or tap on your phone.',
    );
    expect(progressLine('Reading the logs')).toBe('Still working: reading the logs.');
    expect(progressLine(undefined)).toBe(GENERIC_PROGRESS_LINE);
    expect(progressLine('Reading the logs', 'es')).toBe(LINES.es.progress);
  });
});

describe('spoken approvals per language', () => {
  it.each([
    ['हाँ', 'hi', 'approve'],
    ['haan', 'hi', 'approve'],
    ['नहीं', 'hi', 'deny'],
    ['sí', 'es', 'approve'],
    ['no', 'es', 'deny'],
    ['claro', 'es', 'approve'],
    ['vale', 'es', 'approve'],
    ['yes', 'fr', 'approve'],
    ['okay', 'hi', 'approve'],
  ] as const)('%s in %s is %s', (text, language, decision) => {
    expect(approvalVoiceDecision(text, 'Hermes', language)).toBe(decision);
  });

  it('does not take a French oui, or a Hindi haan in an English call', () => {
    expect(approvalVoiceDecision('oui', 'Hermes', 'fr')).toBeUndefined();
    expect(approvalVoiceDecision('haan', 'Hermes')).toBeUndefined();
  });
});

describe('stop words per language', () => {
  it('counts espera as floor control only in a Spanish call', () => {
    expect(isFloorControl(echoWords('espera'), 'es')).toBe(true);
    expect(isFloorControl(echoWords('espera'))).toBe(false);
    expect(isFloorControl(echoWords('wait'), 'es')).toBe(true);
  });
});
