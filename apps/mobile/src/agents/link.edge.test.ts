import type { LinkApproveResponse, LinkRequestDetails } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { callRefusal } from './labels';
import {
  createLinkWizard,
  linkBackAction,
  linkReducer,
  pendingAgentRequests,
  readLinkInput,
  type LinkAction,
  type LinkState,
} from './link';

/** Edge cases for the phone's side of computer-first linking (ADR-025). */

const SERVER = 'https://cord.example.com';
const CONNECTOR_ID = `con_${'a'.repeat(20)}`;
const AGENTS = [
  { local_agent: 'claude-code', kind: 'claude-code' as const, label: 'Claude Code' },
  { local_agent: 'gemini', kind: 'acp' as const, label: 'Gemini CLI' },
  { local_agent: 'codex', kind: 'codex' as const, label: 'Codex' },
];
const DETAILS: LinkRequestDetails = {
  computer_name: 'Work laptop',
  agents: AGENTS,
  expires_at: '2026-10-01T10:10:00.000Z',
  server_time: '2026-10-01T10:00:00.000Z',
};
const LINKED: LinkApproveResponse = {
  connector_id: CONNECTOR_ID,
  computer_name: 'Work laptop',
  agents: AGENTS,
};

const run = (state: LinkState, ...actions: LinkAction[]) => actions.reduce(linkReducer, state);
const qr = (server: string, code = 'ABCDEFGH', extra = '') =>
  `cord://link?code=${code}&server=${encodeURIComponent(server)}${extra}`;

describe('scanned QR codes', () => {
  it.each([
    ['userinfo in front of the host', 'https://cord.example.com@evil.example'],
    ['userinfo naming the right host', 'https://user@cord.example.com'],
    ['another scheme', 'http://cord.example.com'],
    ['another port', 'https://cord.example.com:8443'],
    ['a trailing path', 'https://cord.example.com/evil'],
    ['a look-alike host (Cyrillic \u043e)', 'https://c\u043erd.example.com'],
    ['a look-alike host (Kelvin sign)', 'https://\u212aord.example.com'],
    ['a suffix host', 'https://cord.example.com.evil.example'],
    ['javascript:', 'javascript:alert(1)'],
  ])('refuses a server with %s', (_what, server) => {
    const base = server.includes('\u212a') ? 'https://kord.example.com' : SERVER;
    expect(readLinkInput(qr(server), base).ok).toBe(false);
  });

  it('refuses a QR code with no code, or no server', () => {
    expect(readLinkInput(`cord://link?server=${encodeURIComponent(SERVER)}`, SERVER).ok).toBe(
      false,
    );
    expect(readLinkInput('cord://link?code=ABCDEFGH', SERVER).ok).toBe(false);
    expect(readLinkInput('javascript:alert(1)', SERVER).ok).toBe(false);
    expect(readLinkInput('', SERVER).ok).toBe(false);
  });

  it('ignores extra parameters and the order of parameters', () => {
    expect(readLinkInput(qr(SERVER, 'ABCDEFGH', '&v=2&utm=x'), SERVER)).toEqual({
      ok: true,
      code: 'ABCD-EFGH',
    });
    expect(
      readLinkInput(`cord://link?server=${encodeURIComponent(SERVER)}&code=abcd-efgh`, SERVER),
    ).toEqual({ ok: true, code: 'ABCD-EFGH' });
  });

  it('accepts the server as the computer writes it (trailing slash)', () => {
    expect(readLinkInput(qr(`${SERVER}/`), SERVER).ok).toBe(true);
    expect(readLinkInput(qr(SERVER), `${SERVER}/`).ok).toBe(true);
  });
});

describe('typed codes', () => {
  it('reads lower case, spaces, and a missing or extra dash', () => {
    for (const typed of ['abcdefgh', 'abcd efgh', 'ABCD-EFGH', ' abcd - efgh ', 'AB CD EF GH']) {
      expect(readLinkInput(typed, SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
    }
  });

  it('refuses letters the codes never use (O, 0, I, 1, L)', () => {
    for (const typed of ['ABCD-EFGO', 'ABCD-EFG0', 'ABCD-EFGI', 'ABCD-EFG1', 'ABCD-EFGL']) {
      expect(readLinkInput(typed, SERVER).ok).toBe(false);
    }
  });

  it('upper-cases what is typed and keeps it short', () => {
    const state = run(
      createLinkWizard(),
      { type: 'TYPE_INSTEAD' },
      {
        type: 'SET_TYPED',
        value: 'abcd-efgh-and-more-text',
      },
    );
    expect(state.typed).toBe('ABCD-EFGH-AN');
  });
});

describe('leaving the link wizard', () => {
  const confirm = run(
    createLinkWizard(),
    { type: 'OPEN_SCANNER' },
    { type: 'LOOKUP_STARTED', code: 'ABCD-EFGH' },
    { type: 'FOUND', details: DETAILS },
  );

  it('steps back from the code steps, cancels from confirm, and leaves from the end', () => {
    expect(linkBackAction(run(createLinkWizard(), { type: 'OPEN_SCANNER' }))).toBe('step-back');
    expect(linkBackAction(run(createLinkWizard(), { type: 'TYPE_INSTEAD' }))).toBe('step-back');
    expect(linkBackAction(confirm)).toBe('cancel');
    expect(linkBackAction(createLinkWizard())).toBe('leave');
    expect(linkBackAction(run(confirm, { type: 'APPROVED', linked: LINKED }))).toBe('leave');
  });

  it('does not cancel (reject) while the approval is on its way', () => {
    // The Cancel button is disabled then; Back must not reject a computer that is being linked.
    const approving = run(confirm, { type: 'APPROVE_STARTED' });
    expect(approving.busy).toBe(true);
    expect(linkBackAction(approving)).toBe('stay');
  });

  it('does not leave while agents are being added', () => {
    const saving = run(confirm, { type: 'APPROVED', linked: LINKED }, { type: 'SAVE_STARTED' });
    expect(linkBackAction(saving)).toBe('stay');
  });
});

describe('approve and add', () => {
  it('ignores a second tap on Link or Add while busy', () => {
    const confirm = run(createLinkWizard(), { type: 'FOUND', details: DETAILS });
    const once = run(confirm, { type: 'APPROVE_STARTED' });
    const twice = run(once, { type: 'APPROVE_STARTED' });
    expect(twice).toEqual(once);
    const pick = run(once, { type: 'APPROVED', linked: LINKED }, { type: 'SAVE_STARTED' });
    expect(run(pick, { type: 'SAVE_STARTED' })).toEqual(pick);
  });

  it('lets Link be tried again after a network error', () => {
    const failed = run(
      createLinkWizard(),
      { type: 'FOUND', details: DETAILS },
      { type: 'APPROVE_STARTED' },
      { type: 'FAILED', copy: { message: 'No network', retryable: true } },
    );
    expect(failed.step).toBe('confirm');
    expect(failed.busy).toBe(false);
    expect(run(failed, { type: 'APPROVE_STARTED' }).busy).toBe(true);
  });

  it('adds the rest after a save fails part-way, never one twice', () => {
    let state = run(
      createLinkWizard(),
      { type: 'APPROVED', linked: LINKED },
      { type: 'SAVE_STARTED' },
      { type: 'AGENT_SAVED', localAgent: 'claude-code' },
      { type: 'FAILED', copy: { message: 'No network', retryable: true } },
    );
    expect(state.step).toBe('pick');
    expect(pendingAgentRequests(state).map((p) => p.localAgent)).toEqual(['gemini', 'codex']);
    // A saved agent cannot be unticked, and a repeated "saved" changes nothing.
    state = run(state, { type: 'AGENT_SAVED', localAgent: 'claude-code' });
    expect(state.saved).toEqual(['claude-code']);
    state = run(
      state,
      { type: 'SAVE_STARTED' },
      { type: 'AGENT_SAVED', localAgent: 'gemini' },
      { type: 'AGENT_SAVED', localAgent: 'codex' },
      { type: 'ALL_SAVED' },
    );
    expect(state.step).toBe('done');
    expect(pendingAgentRequests(state)).toEqual([]);
  });

  it('lets the user untick an unsaved agent after a failure and finish with the saved ones', () => {
    const state = run(
      createLinkWizard(),
      { type: 'APPROVED', linked: LINKED },
      { type: 'SAVE_STARTED' },
      { type: 'AGENT_SAVED', localAgent: 'claude-code' },
      { type: 'FAILED', copy: { message: 'No network', retryable: true } },
      { type: 'TOGGLE', localAgent: 'gemini' },
      { type: 'TOGGLE', localAgent: 'codex' },
    );
    expect(pendingAgentRequests(state)).toEqual([]);
    expect(run(state, { type: 'SAVE_STARTED' }).busy).toBe(true);
  });
});

describe('calling a computer agent', () => {
  it('calls when the status is unknown, loading, or online', () => {
    expect(callRefusal({})).toBeUndefined();
    expect(callRefusal({ connector_online: true })).toBeUndefined();
  });

  it('says the computer is offline before calling', () => {
    expect(callRefusal({ connector_online: false })?.message).toMatch(/is offline/);
  });

  it('says the computer was removed, not offline, when it was removed', () => {
    // The gateway reports a removed computer as offline too (it cannot be connected).
    const refusal = callRefusal({ connector_online: false, connector_removed: true });
    expect(refusal?.message).toMatch(/no longer paired|removed/i);
    expect(refusal?.message).not.toMatch(/is offline/);
  });
});
