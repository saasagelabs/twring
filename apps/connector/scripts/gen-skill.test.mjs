import { describe, expect, it } from 'vitest';

import { HERMES_HEADER, generateSkill, renderFor, withHermesHeader } from './gen-skill.mjs';

const source = [
  'Shared line.',
  '<!-- only:hermes -->',
  'Use the `twring_ring_owner` tool.',
  '<!-- /only -->',
  '<!-- not:hermes -->',
  'Run `twring-connect ring "..."`.',
  '<!-- /not -->',
  'Last line.',
  '',
].join('\n');

describe('agent markers', () => {
  it('gives the generic build the not:hermes text and drops the markers', () => {
    expect(renderFor(source, 'generic')).toBe(
      'Shared line.\nRun `twring-connect ring "..."`.\nLast line.\n',
    );
  });

  it('gives the Hermes build the only:hermes text and drops the markers', () => {
    expect(renderFor(source, 'hermes')).toBe(
      'Shared line.\nUse the `twring_ring_owner` tool.\nLast line.\n',
    );
  });

  it('reads CRLF sources the same as LF ones', () => {
    expect(renderFor(source.replace(/\n/g, '\r\n'), 'hermes')).toBe(renderFor(source, 'hermes'));
  });

  it('rejects nested, unmatched, unclosed and inline markers with the file and line', () => {
    expect(() =>
      renderFor('<!-- only:hermes -->\n<!-- not:hermes -->\n', 'generic', 'SKILL.md'),
    ).toThrow('SKILL.md:2: nested agent marker');
    expect(() => renderFor('a\n<!-- /only -->\n', 'generic', 'SKILL.md')).toThrow(
      'SKILL.md:2: unmatched marker',
    );
    expect(() => renderFor('<!-- not:hermes -->\na\n', 'generic', 'x.md')).toThrow(
      'x.md:1: agent marker is never closed',
    );
    expect(() => renderFor('a <!-- only:hermes --> b\n', 'hermes', 'x.md')).toThrow(
      'x.md:1: an agent marker must be alone on its line',
    );
  });
});

describe('Hermes header', () => {
  it('goes after the frontmatter of SKILL.md, so the file still starts with ---', () => {
    const out = withHermesHeader('SKILL.md', '---\nname: twring\n---\n\n# Title\n');
    expect(out).toBe(`---\nname: twring\n---\n${HERMES_HEADER}\n\n# Title\n`);
  });

  it('goes first in a reference file', () => {
    expect(withHermesHeader('references/voice.md', '# Voice\n')).toBe(
      `${HERMES_HEADER}\n\n# Voice\n`,
    );
  });
});

describe('checked-in builds', () => {
  it('match the source (run pnpm --filter @twring/connector gen:skill if this fails)', async () => {
    expect(await generateSkill({ check: true })).toEqual([]);
  });
});
