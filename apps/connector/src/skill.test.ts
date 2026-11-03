import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AGENT_HANGUP_LINGER_MS,
  MAX_AGENT_KEYTERMS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  HANGUP_MARKERS,
  RING_INVITE_TTL_MS,
  RING_RATE_PER_AGENT_PER_HOUR,
  ringReasonSchema,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { RING_EXIT } from './ring';
import { withFilePaths } from './turn-files';

/** The agent skill pack (skills/twring) must describe Twring as it behaves. */
const skillDir = fileURLToPath(new URL('../../../skills/twring/', import.meta.url));
const read = (path: string) => readFileSync(`${skillDir}${path}`, 'utf8');
const skill = read('SKILL.md');
const ringing = read('references/ringing.md');
const longWork = read('references/approvals-and-long-work.md');
const voice = read('references/voice.md');

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  if (block === null) throw new Error('SKILL.md has no frontmatter');
  const fields: Record<string, string> = {};
  for (const line of block[1]!.split('\n')) {
    const field = /^([a-z_]+):\s*(.+)$/.exec(line);
    if (field !== null) fields[field[1]!] = field[2]!;
  }
  return fields;
}

describe('twring agent skill', () => {
  it('has the frontmatter the Agent Skills format requires', () => {
    const fields = frontmatter(skill);
    expect(fields.name).toBe('twring');
    expect(fields.description).toBeDefined();
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
  });

  it('links only to reference files that exist', () => {
    const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(`${skillDir}${link}`), link).toBe(true);
  });

  it('uses the hang-up marker and linger the gateway uses', () => {
    expect(skill).toContain(HANGUP_MARKERS[0]);
    expect(AGENT_HANGUP_LINGER_MS).toBe(6_000);
    expect(skill).toContain('six seconds later');
  });

  it('lists the ring exit codes the connector returns', () => {
    const rows: [number, string][] = [
      [RING_EXIT.answered, 'Answered'],
      [RING_EXIT.refused, 'Refused'],
      [RING_EXIT.declined, 'Declined'],
      [RING_EXIT.missed, 'Missed'],
      [RING_EXIT.cancelled, 'Cancelled'],
      [RING_EXIT.error, 'Error'],
    ];
    for (const [code, label] of rows) {
      const row = new RegExp(`\\| ${code} \\| [^|\\n]*${label}`, 'i');
      expect(ringing, `${code} ${label}`).toMatch(row);
      expect(skill, `${code} ${label}`).toMatch(row);
    }
  });

  it('states the ring limits the gateway enforces', () => {
    expect(ringReasonSchema.safeParse('x'.repeat(140)).success).toBe(true);
    expect(ringReasonSchema.safeParse('x'.repeat(141)).success).toBe(false);
    expect(skill).toContain('140 characters');
    expect(RING_RATE_PER_AGENT_PER_HOUR).toBe(6);
    expect(skill).toContain('six rings an hour');
    expect(RING_INVITE_TTL_MS).toBe(30_000);
    expect(ringing).toContain('30 seconds');
  });

  it('describes incoming files the way the connector and gateway present them', () => {
    // The connector's line for a file it saved (turn-files.ts).
    const saved = withFilePaths('hi', [
      { path: '/tmp/x/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
    ]).split('\n')[1]!;
    expect(saved.startsWith('Saved on this computer: ')).toBe(true);
    expect(skill).toContain('`Saved on this computer: <path>`');
    // The gateway's line for every attachment (threads/service.ts).
    expect(skill).toContain('`[Attached: receipt.jpg (JPEG image, 1.2 MB)]`');
    expect(skill).toContain(
      `up to ${['zero', 'one', 'two', 'three', 'four', 'five'][MAX_ATTACHMENTS_PER_MESSAGE]}, ${MAX_FILE_BYTES / 1024 / 1024} MB each`,
    );
  });

  it('is version 0.6.1', () => {
    expect(skill.replace(/\r\n/g, '\n')).toMatch(/\n {2}version: 0\.6\.1\n/);
  });

  it('makes agents write down what the owner asks for on a call, in the same turn', () => {
    expect(skill).toContain('## Requests made on a call');
    expect(skill).toContain('write it down in that same turn, before anything else');
    expect(skill).toContain('read that list after every call');
    // Its own list, never a project's TODO file, and never a secret in it.
    expect(skill).toContain('`twring-requests.md`');
    expect(skill).toContain('Never write passwords, keys or tokens into it');
    // A team member's session on a shared agent is given its own file: only that one.
    expect(skill).toContain(
      'If your instructions name a different requests file, use only that file and never read another.',
    );
    // Agents that can't write (read-only setups) have a way out.
    expect(skill).toContain('If you can’t write anything down here');
  });

  it('only hangs up after a clear goodbye', () => {
    expect(skill).toContain('Hang up only when your owner clearly says goodbye');
  });

  it('teaches adding words with the real limit, by command and by tool', () => {
    expect(skill).toContain('twring-connect words "');
    expect(skill).toContain('`add_words`');
    expect(skill).toContain(`Up to ${MAX_AGENT_KEYTERMS}`);
  });

  it('names the tools on this computer and the ones a connected app has', () => {
    for (const tool of ['ring_owner', 'message_owner', 'ring_me', 'message_me', 'check_replies']) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
  });

  it('says Twring answers a slow start itself, so the agent does not repeat it', () => {
    expect(skill).toContain('"Okay, one moment."');
    expect(longWork).toContain('1.5 s');
  });

  it('puts feeling in words and punctuation, not tags the voice drops or reads out', () => {
    expect(skill).toContain('## Sound like a person');
    expect(voice).toContain('## Sounding human');
    expect(skill).toContain('[laughter]');
  });
});
