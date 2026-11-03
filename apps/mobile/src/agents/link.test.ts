import type { LinkApproveResponse, LinkRequestDetails } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';

import {
  addLabel,
  agentDescription,
  confirmTitle,
  createLinkWizard,
  doneCopy,
  linkCommand,
  linkErrorCopy,
  linkReducer,
  pendingAgentRequests,
  readLinkInput,
  stepNeedsLinkCode,
  type LinkAction,
  type LinkState,
} from './link';

const SERVER = 'https://cord.example.com';
const CONNECTOR_ID = `con_${'a'.repeat(20)}`;
const AGENTS = [
  { local_agent: 'claude-code', kind: 'claude-code' as const, label: 'Claude Code' },
  { local_agent: 'gemini', kind: 'acp' as const, label: 'Gemini CLI' },
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

describe('expired codes and typed dashes', () => {
  it('reads a typed code with a Unicode dash', () => {
    expect(readLinkInput('abcd–efgh', SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
    expect(readLinkInput('ABCD−EFGH', SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
  });

  it('says exactly that an expired or cancelled code expired', () => {
    const expired = new ApiError('http', 'pairing_invalid', 'r1', undefined, 410);
    expect(linkErrorCopy(expired)).toEqual({
      message: 'That code expired. Get a new code on your computer and try again.',
      retryable: false,
    });
    // A wrong code keeps the usual copy.
    const wrong = new ApiError('http', 'pairing_invalid', 'r1', undefined, 400);
    expect(linkErrorCopy(wrong).message).not.toBe(
      'That code expired. Get a new code on your computer and try again.',
    );
  });
});

describe('link wizard', () => {
  it('downloads the connector and starts the no-code link flow on this server', () => {
    const command = linkCommand(`${SERVER}/api/`);
    expect(command).toBe(
      `curl -fsSL ${SERVER}/api/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs --server ${SERVER}/api`,
    );
    expect(command).not.toContain('npx');
  });

  it('refuses a server that cannot safely form a command', () => {
    expect(linkCommand('')).toBeUndefined();
    expect(linkCommand('https://me:pw@cord.example.com')).toBeUndefined();
    expect(linkCommand('https://cord.example.com/$(id)')).toBeUndefined();
  });

  it('reads a scanned QR code for this server', () => {
    const qr = `cord://link?code=ABCDEFGH&server=${encodeURIComponent(`${SERVER}/`)}`;
    expect(readLinkInput(qr, SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
    expect(readLinkInput(qr, 'HTTPS://CORD.EXAMPLE.COM/')).toEqual({
      ok: true,
      code: 'ABCD-EFGH',
    });
  });

  it('refuses a QR code made for another server', () => {
    const qr = `cord://link?code=ABCDEFGH&server=${encodeURIComponent('https://evil.example')}`;
    const read = readLinkInput(qr, SERVER);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toMatch(/different Twring server/);
  });

  it('accepts a typed code in any case, with or without the dash', () => {
    expect(readLinkInput('abcdefgh', SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
    expect(readLinkInput(' ABCD-EFGH ', SERVER)).toEqual({ ok: true, code: 'ABCD-EFGH' });
    expect(readLinkInput('ABC', SERVER).ok).toBe(false);
    expect(readLinkInput('https://example.com', SERVER).ok).toBe(false);
  });

  it('moves between start, scanner, and typing', () => {
    let state = run(createLinkWizard(), { type: 'OPEN_SCANNER' });
    expect(state.step).toBe('scan');
    state = run(state, { type: 'TYPE_INSTEAD' });
    expect(state.step).toBe('type');
    state = run(state, { type: 'SET_TYPED', value: 'abcd-efgh' });
    expect(state.typed).toBe('ABCD-EFGH');
    expect(run(state, { type: 'BACK' }).step).toBe('start');
  });

  it('confirms, approves, and preselects every agent', () => {
    const state = run(
      createLinkWizard(),
      { type: 'OPEN_SCANNER' },
      { type: 'LOOKUP_STARTED', code: 'ABCD-EFGH' },
    );
    expect(state.busy).toBe(true);
    const found = run(state, { type: 'FOUND', details: DETAILS });
    expect(found.step).toBe('confirm');
    expect(confirmTitle(DETAILS)).toBe('Link Work laptop?');
    const approved = run(found, { type: 'APPROVE_STARTED' }, { type: 'APPROVED', linked: LINKED });
    expect(approved.step).toBe('pick');
    expect(approved.selected).toEqual(['claude-code', 'gemini']);
    expect(run(approved, { type: 'BACK' }).step).toBe('pick');
  });

  it('shows a lookup failure and stays on the code step', () => {
    const state = run(
      createLinkWizard(),
      { type: 'TYPE_INSTEAD' },
      { type: 'LOOKUP_STARTED', code: 'ABCD-EFGH' },
      { type: 'FAILED', copy: { message: 'Wrong code', retryable: true } },
    );
    expect(state.step).toBe('type');
    expect(state.busy).toBe(false);
    expect(state.error?.message).toBe('Wrong code');
  });

  it('toggles agents and never saves one twice', () => {
    let state = run(createLinkWizard(), { type: 'APPROVED', linked: LINKED });
    state = run(state, { type: 'TOGGLE', localAgent: 'gemini' });
    expect(state.selected).toEqual(['claude-code']);
    expect(addLabel(state.selected.length)).toBe('Add 1 agent');
    state = run(state, { type: 'TOGGLE', localAgent: 'gemini' });
    expect(addLabel(state.selected.length)).toBe('Add 2 agents');

    expect(pendingAgentRequests(state)).toEqual([
      {
        localAgent: 'claude-code',
        request: {
          name: 'Claude Code',
          protocol: 'cord-connector',
          endpoint_url: `cord-connector://${CONNECTOR_ID}/claude-code`,
        },
      },
      expect.objectContaining({ localAgent: 'gemini' }),
    ]);
    state = run(
      state,
      { type: 'SAVE_STARTED' },
      { type: 'AGENT_SAVED', localAgent: 'claude-code' },
    );
    expect(pendingAgentRequests(state).map((p) => p.localAgent)).toEqual(['gemini']);
    // A save in flight freezes the selection.
    expect(run(state, { type: 'TOGGLE', localAgent: 'gemini' }).selected).toEqual(state.selected);
    expect(run(state, { type: 'ALL_SAVED' }).step).toBe('done');
  });

  it('the last step says reconnected for contacts a computer linked again took over', () => {
    const base = run(createLinkWizard(), { type: 'APPROVED', linked: LINKED });
    expect(doneCopy(run(base, { type: 'AGENT_SAVED', localAgent: 'claude-code' }))).toEqual({
      heading: 'Your agents are ready',
      support: 'Call them from Home. Leave your computer on while you call.',
      reconnected: {},
    });
    const one = run(base, {
      type: 'AGENT_SAVED',
      localAgent: 'claude-code',
      relinkedAs: 'Hermes',
    });
    expect(doneCopy(one)).toEqual({
      heading: 'Reconnected to Hermes',
      support: 'Your chats and calls are still here. Leave your computer on while you call.',
      reconnected: { 'claude-code': 'Hermes' },
    });
    const mixed = run(one, { type: 'AGENT_SAVED', localAgent: 'gemini' });
    expect(doneCopy(mixed)).toMatchObject({
      heading: 'Your agents are ready',
      reconnected: { 'claude-code': 'Hermes' },
    });
  });

  it('will not save with nothing selected', () => {
    let state = run(createLinkWizard(), { type: 'APPROVED', linked: LINKED });
    state = run(
      state,
      { type: 'TOGGLE', localAgent: 'gemini' },
      { type: 'TOGGLE', localAgent: 'claude-code' },
    );
    expect(run(state, { type: 'SAVE_STARTED' }).busy).toBe(false);
  });

  it('describes agents in plain words', () => {
    expect(agentDescription({ local_agent: 'claude-code', kind: 'claude-code' })).toBe(
      "Anthropic's coding agent",
    );
    expect(agentDescription({ local_agent: 'custom', kind: 'command' })).toBe(
      'An agent on your computer',
    );
  });
});

describe('which steps need a link code', () => {
  it('saving picked agents runs without one (a computer linked by an agent message)', () => {
    expect(stepNeedsLinkCode('pick')).toBe(false);
    expect(stepNeedsLinkCode('done')).toBe(false);
    for (const step of ['scan', 'type', 'confirm'] as const) {
      expect(stepNeedsLinkCode(step)).toBe(true);
    }
  });
});
