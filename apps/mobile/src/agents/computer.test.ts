import type { Connector, PairingStatusResponse } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';

import {
  computerAgentRequest,
  computerReducer,
  connectCommand,
  createComputerWizard,
  onPhoneClock,
  PAIRING_EXPIRY_GRACE_MS,
  pairingTimedOut,
  readyCopy,
  timeLeft,
  waitForClaim,
  type ComputerAction,
  type ComputerState,
} from './computer';

const CONNECTOR: Connector = {
  id: `con_${'a'.repeat(20)}`,
  name: 'Work laptop',
  online: true,
  created_at: '2026-09-30T10:00:00.000Z',
  agents: [
    { id: 'claude-code', label: 'Claude Code', kind: 'claude-code' },
    { id: 'gemini', label: 'Gemini CLI', kind: 'acp' },
  ],
};

const run = (state: ComputerState, ...actions: ComputerAction[]) =>
  actions.reduce(computerReducer, state);

describe('computer wizard', () => {
  it('builds the command with the code and server, without a trailing slash', () => {
    expect(connectCommand('ABCD-EFGH', 'https://cord.example.com/')).toBe(
      'npx twring-connect --code ABCD-EFGH --server https://cord.example.com',
    );
  });

  it('counts down and reports expiry', () => {
    const now = Date.parse('2026-09-30T10:00:00Z');
    expect(timeLeft('2026-09-30T10:09:41Z', now)).toBe('9:41');
    expect(timeLeft('2026-09-30T10:00:00Z', now)).toBeUndefined();
    expect(timeLeft('not a date', now)).toBeUndefined();
  });

  it('counts down on the server clock, not a phone clock that is off', () => {
    // The phone's clock is 7 minutes behind the server's.
    const receivedAt = Date.parse('2026-09-30T09:53:00Z');
    const pairing = onPhoneClock(
      {
        pairing_id: `pair_${'a'.repeat(20)}`,
        code: 'ABCD-EFGH',
        expires_at: '2026-09-30T10:10:00.000Z',
        server_time: '2026-09-30T10:00:00.000Z',
      },
      receivedAt,
    );
    // Ten minutes from when the answer arrived, whatever the phone thinks the time is.
    expect(timeLeft(pairing.expires_at, receivedAt)).toBe('10:00');
    // Without server_time, expires_at is taken as is.
    expect(onPhoneClock({ expires_at: '2026-09-30T10:10:00.000Z' }, receivedAt).expires_at).toBe(
      '2026-09-30T10:10:00.000Z',
    );
  });

  it('lets the poll decide at expiry: gives up locally only after the grace', () => {
    const expiresAt = '2026-09-30T10:10:00.000Z';
    const at = Date.parse(expiresAt);
    expect(timeLeft(expiresAt, at)).toBeUndefined();
    expect(pairingTimedOut(expiresAt, at)).toBe(false);
    expect(pairingTimedOut(expiresAt, at + PAIRING_EXPIRY_GRACE_MS - 1)).toBe(false);
    expect(pairingTimedOut(expiresAt, at + PAIRING_EXPIRY_GRACE_MS)).toBe(true);
    // A claim that lands at 0:00 still shows the paired computer.
    const state = run(createComputerWizard(), {
      type: 'PAIRING_CREATED',
      pairing: { pairing_id: `pair_${'a'.repeat(20)}`, code: 'ABCD-EFGH', expires_at: expiresAt },
    });
    expect(run(state, { type: 'CLAIMED', connector: CONNECTOR }).connector).toEqual(CONNECTOR);
  });

  it('walks pair → agent → name → voice → ready and builds a cord-connector agent', () => {
    let state = createComputerWizard();
    expect(run(state, { type: 'NEXT' }).step).toBe('pair');
    state = run(
      state,
      { type: 'CLAIMED', connector: CONNECTOR },
      { type: 'PICK_AGENT', agent: CONNECTOR.agents[1] },
      { type: 'NEXT' },
    );
    expect(state).toMatchObject({ step: 'name', name: 'Gemini CLI' });
    state = run(state, { type: 'SET_NAME', value: ' Laptop Gemini ' }, { type: 'NEXT' });
    state = run(state, { type: 'SET_VOICE', value: 'flux-haley-en' });
    expect(computerAgentRequest(state)).toEqual({
      name: 'Laptop Gemini',
      protocol: 'cord-connector',
      endpoint_url: `cord-connector://${CONNECTOR.id}/gemini`,
      voice_id: 'flux-haley-en',
    });
    expect(run(state, { type: 'SAVED', agentId: 'agt_x', name: 'Laptop Gemini' }).step).toBe(
      'ready',
    );
  });

  it('the last step says reconnected when a computer linked again took over its old contact', () => {
    const fresh = run(createComputerWizard(), {
      type: 'SAVED',
      agentId: 'agt_x',
      name: 'Hermes',
    });
    expect(readyCopy(fresh)).toEqual({
      heading: 'Hermes is ready',
      support: 'Leave your computer on while you call.',
    });
    const relinked = run(createComputerWizard(), {
      type: 'SAVED',
      agentId: 'agt_x',
      name: 'Hermes',
      relinked: true,
    });
    expect(readyCopy(relinked)).toEqual({
      heading: 'Reconnected to Hermes',
      support: 'Your chats and calls are still here. Leave your computer on while you call.',
    });
  });

  it('preselects the only agent a computer offers', () => {
    const state = run(createComputerWizard(), {
      type: 'CLAIMED',
      connector: { ...CONNECTOR, agents: [CONNECTOR.agents[0]] },
    });
    expect(state.localAgent?.id).toBe('claude-code');
    expect(state.name).toBe('Claude Code');
  });

  it('keeps a typed name when another agent is picked', () => {
    const state = run(
      createComputerWizard(),
      { type: 'CLAIMED', connector: CONNECTOR },
      { type: 'PICK_AGENT', agent: CONNECTOR.agents[0] },
      { type: 'SET_NAME', value: 'Coder' },
      { type: 'PICK_AGENT', agent: CONNECTOR.agents[1] },
    );
    expect(state.name).toBe('Coder');
  });

  it('shows expiry only while unclaimed', () => {
    const expired = run(createComputerWizard(), { type: 'PAIRING_EXPIRED' });
    expect(expired.pairing.kind).toBe('expired');
    const claimed = run(
      createComputerWizard(),
      { type: 'CLAIMED', connector: CONNECTOR },
      { type: 'PAIRING_EXPIRED' },
    );
    expect(claimed.pairing.kind).toBe('loading');
  });
});

describe('waitForClaim', () => {
  const sleep = () => Promise.resolve();

  it('polls until the code is claimed, riding out a failed poll', async () => {
    const claimed: PairingStatusResponse = {
      status: 'claimed',
      expires_at: '2026-09-30T10:10:00Z',
      connector: CONNECTOR,
    };
    const getPairing = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', expires_at: claimed.expires_at })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(claimed);
    const result = await waitForClaim({ getPairing }, 'pair_x', new AbortController().signal, {
      sleep,
    });
    expect(result).toEqual(claimed);
    expect(getPairing).toHaveBeenCalledTimes(3);
  });

  it('treats a pairing the server no longer knows (it restarted) as expired, not as offline', async () => {
    const getPairing = vi.fn().mockRejectedValue(new ApiError('http', 'not_found', 'req_1'));
    const controller = new AbortController();
    const settled = waitForClaim({ getPairing }, 'pair_x', controller.signal, {
      sleep: () =>
        getPairing.mock.calls.length > 20
          ? Promise.reject(new Error('looping'))
          : Promise.resolve(),
    });
    const result = await settled.then(
      (r) => r.status,
      (e: unknown) => (e as Error).message,
    );
    controller.abort();
    expect(result).toBe('expired');
    expect(getPairing).toHaveBeenCalledTimes(1);
  });

  it('stops when the code expires', async () => {
    const getPairing = vi.fn().mockResolvedValue({ status: 'expired', expires_at: 'x' });
    const result = await waitForClaim({ getPairing }, 'pair_x', new AbortController().signal, {
      sleep,
    });
    expect(result.status).toBe('expired');
  });
});
