import type { Agent, ConnectionTestResponse } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TwringApi } from '../api/client';
import { shouldShowOnboarding } from '../onboarding/state';

import {
  connectionPatch,
  CREATE_STEPS,
  EDIT_STEPS,
  textEntryFor,
  createWizard,
  editWizard,
  saveAndTest,
  stepPosition,
  validateStep,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from './wizard';

const AGENT: Agent = {
  id: 'agt_abcdefghij0123456789',
  name: 'Operator',
  protocol: 'cord-native',
  endpoint_url: 'wss://agent.example.com/cord',
  voice_id: 'flux-thalia-en',
  keyterms: [],
  has_credential: true,
  status: 'untested',
  created_at: '2026-09-20T10:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
};

const PASSED: ConnectionTestResponse = {
  agent: { ...AGENT, status: 'ready' },
  result: {
    ok: true,
    checks: [{ name: 'endpoint', status: 'passed' }],
    message: 'ok',
    tested_at: '2026-09-20T10:00:00.000Z',
  },
};

function run(state: WizardState, ...actions: WizardAction[]): WizardState {
  return actions.reduce(wizardReducer, state);
}

function fakeApi() {
  const mocks = {
    createAgent: vi.fn<TwringApi['createAgent']>(() => Promise.resolve(AGENT)),
    updateAgent: vi.fn<TwringApi['updateAgent']>(() => Promise.resolve(AGENT)),
    testAgent: vi.fn<TwringApi['testAgent']>(() => Promise.resolve(PASSED)),
  };
  const api: TwringApi = {
    agentAvatarUrl: vi.fn<TwringApi['agentAvatarUrl']>(),
    setAgentAvatar: vi.fn<TwringApi['setAgentAvatar']>(),
    removeAgentAvatar: vi.fn<TwringApi['removeAgentAvatar']>(),
    messageSpeechUrl: vi.fn<TwringApi['messageSpeechUrl']>(),
    listSpeechKeys: vi.fn<TwringApi['listSpeechKeys']>(),
    saveSpeechKey: vi.fn<TwringApi['saveSpeechKey']>(),
    removeSpeechKey: vi.fn<TwringApi['removeSpeechKey']>(),
    speechKeyState: vi.fn<TwringApi['speechKeyState']>(),
    setListeningProvider: vi.fn<TwringApi['setListeningProvider']>(),
    serverInfo: vi.fn<TwringApi['serverInfo']>(),
    listPeople: vi.fn<TwringApi['listPeople']>(),
    createMemberCode: vi.fn<TwringApi['createMemberCode']>(),
    removePerson: vi.fn<TwringApi['removePerson']>(),
    listVoices: vi.fn<TwringApi['listVoices']>(),
    listThreads: vi.fn<TwringApi['listThreads']>(),
    listMessages: vi.fn<TwringApi['listMessages']>(),
    sendMessage: vi.fn<TwringApi['sendMessage']>(),
    sendVoiceNote: vi.fn<TwringApi['sendVoiceNote']>(),
    stopMessage: vi.fn<TwringApi['stopMessage']>(),
    markRead: vi.fn<TwringApi['markRead']>(),
    clearChat: vi.fn<TwringApi['clearChat']>(),
    newConversation: vi.fn<TwringApi['newConversation']>(),
    decideChatApproval: vi.fn<TwringApi['decideChatApproval']>(),
    listAgents: vi.fn<TwringApi['listAgents']>(),
    getAgent: vi.fn<TwringApi['getAgent']>(),
    deleteAgent: vi.fn<TwringApi['deleteAgent']>(),
    callHistory: vi.fn<TwringApi['callHistory']>(),
    sendCallFeedback: vi.fn<TwringApi['sendCallFeedback']>(),
    sendAppFeedback: vi.fn(() => Promise.resolve()),
    deleteMyData: vi.fn<TwringApi['deleteMyData']>(),
    usage: vi.fn<TwringApi['usage']>(),
    createPairing: vi.fn<TwringApi['createPairing']>(),
    getPairing: vi.fn<TwringApi['getPairing']>(),
    getLinkRequest: vi.fn<TwringApi['getLinkRequest']>(),
    approveLink: vi.fn<TwringApi['approveLink']>(),
    rejectLink: vi.fn<TwringApi['rejectLink']>(),
    listConnectors: vi.fn<TwringApi['listConnectors']>(),
    listConnectedApps: vi.fn<TwringApi['listConnectedApps']>(),
    blockConnectedApp: vi.fn<TwringApi['blockConnectedApp']>(),
    allowConnectedApp: vi.fn<TwringApi['allowConnectedApp']>(),
    history: vi.fn<TwringApi['history']>(),
    registerDevice: vi.fn<TwringApi['registerDevice']>(),
    unregisterDevice: vi.fn<TwringApi['unregisterDevice']>(),
    ringSettings: vi.fn<TwringApi['ringSettings']>(),
    updateRingSettings: vi.fn<TwringApi['updateRingSettings']>(),
    getInvite: vi.fn<TwringApi['getInvite']>(),
    pendingInvites: vi.fn<TwringApi['pendingInvites']>(),
    answerInvite: vi.fn<TwringApi['answerInvite']>(),
    declineInvite: vi.fn<TwringApi['declineInvite']>(),
    decideApproval: vi.fn<TwringApi['decideApproval']>(),
    ...mocks,
  };
  return { api, ...mocks };
}

/** A create wizard filled in up to the test step. */
function filled(): WizardState {
  return run(
    createWizard(),
    { type: 'SET_NAME', value: ' Operator ' },
    { type: 'NEXT' },
    { type: 'NEXT' },
    { type: 'SET_ENDPOINT', value: 'wss://agent.example.com/cord' },
    { type: 'NEXT' },
    { type: 'SET_CREDENTIAL', value: 'sk-secret' },
    { type: 'NEXT' },
  );
}

describe('connect wizard', () => {
  it('walks the OpenAI-compatible model step and saves its model', async () => {
    const { api, createAgent, testAgent } = fakeApi();
    const state = run(
      createWizard(),
      { type: 'SET_NAME', value: 'OpenClaw' },
      { type: 'NEXT' },
      { type: 'SET_PROTOCOL', value: 'openai-chat' },
      { type: 'NEXT' },
      { type: 'SET_ENDPOINT', value: 'https://agent.example.com/v1' },
      { type: 'NEXT' },
      { type: 'NEXT' },
      { type: 'SET_MODEL', value: ' openclaw:main ' },
      { type: 'NEXT' },
    );
    expect(state.step).toBe('test');
    expect(stepPosition(state)).toEqual({ index: 6, total: 8 });
    await saveAndTest(api, state, () => undefined);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'openai-chat', model: 'openclaw:main' }),
      undefined,
    );
    expect(testAgent).toHaveBeenCalled();
    expect(validateStep({ ...state, step: 'model', model: 'x'.repeat(201) })).toBe(
      'Use 200 characters or fewer.',
    );
    expect(
      connectionPatch({
        ...editWizard({ ...AGENT, protocol: 'openai-chat', model: 'old' }),
        model: '',
        dirty: true,
      })?.model,
    ).toBeNull();
  });
  it('walks every step when creating', () => {
    const state = filled();
    expect(state.step).toBe('test');
    expect(stepPosition(state)).toEqual({ index: 5, total: 7 });
  });

  it('stays put while a step is invalid', () => {
    const start = createWizard();
    expect(validateStep(start)).toBe('Give your agent a name.');
    expect(run(start, { type: 'NEXT' }).step).toBe('name');
    const long = run(start, { type: 'SET_NAME', value: 'x'.repeat(61) });
    expect(validateStep(long)).toBe('Use 60 characters or fewer.');
  });

  it('checks the endpoint scheme against the connection method', () => {
    const at = (protocol: 'cord-native' | 'cord-rest', value: string) =>
      validateStep({ ...createWizard(), step: 'endpoint', protocol, endpoint: value });
    expect(at('cord-native', '')).toBe('Enter the address of your agent.');
    expect(at('cord-native', 'https://agent.example.com')).toContain('wss://');
    expect(at('cord-rest', 'wss://agent.example.com')).toContain('https://');
    expect(at('cord-rest', 'https://')).toContain("doesn't look like a full address");
    expect(at('cord-native', 'wss://agent.example.com/cord')).toBeUndefined();
    expect(at('cord-rest', 'http://localhost:8787/cord/turns')).toBeUndefined();
  });

  it('goes back, but not while a test is running', () => {
    const testing = run(filled(), { type: 'TEST_STARTED' });
    expect(run(testing, { type: 'BACK' }).step).toBe('test');
    expect(run(filled(), { type: 'BACK' }).step).toBe('credential');
  });

  it('continues past the test only when it passed', () => {
    const failed = run(
      filled(),
      { type: 'TEST_STARTED' },
      { type: 'TEST_FINISHED', agent: AGENT, result: { ...PASSED.result, ok: false } },
    );
    expect(run(failed, { type: 'NEXT' }).step).toBe('test');
    const passed = run(
      filled(),
      { type: 'TEST_STARTED' },
      { type: 'TEST_FINISHED', agent: AGENT, result: PASSED.result },
    );
    expect(run(passed, { type: 'NEXT' }).step).toBe('voice');
  });

  it('ignores a late test result after leaving the test step', () => {
    const left = run(filled(), { type: 'TEST_STARTED' });
    const back = { ...left, test: { kind: 'idle' as const }, step: 'credential' as const };
    expect(run(back, { type: 'TEST_FAILED', copy: { message: 'x', retryable: true } })).toBe(back);
  });

  it('forgets the typed key once saved', () => {
    const saved = run(filled(), { type: 'SAVED', agent: AGENT });
    expect(saved.credential).toBe('');
    expect(saved.agentId).toBe(AGENT.id);
    expect(saved.hasSavedCredential).toBe(true);
    expect(saved.voiceId).toBe('flux-thalia-en');
    expect(saved.dirty).toBe(false);
  });

  it('edits only the connection, ending at the test', () => {
    const edit = editWizard(AGENT);
    expect(edit.step).toBe('method');
    expect(stepPosition(edit)).toEqual({ index: 1, total: 4 });
    expect(connectionPatch(edit)).toBeUndefined();
    const removing = run(edit, { type: 'SET_REMOVE_CREDENTIAL', value: true });
    expect(connectionPatch(removing)).toEqual({
      protocol: 'cord-native',
      endpoint_url: 'wss://agent.example.com/cord',
      credential: null,
    });
    const typed = run(removing, { type: 'SET_CREDENTIAL', value: 'new' });
    expect(typed.removeCredential).toBe(false);
    expect(connectionPatch(typed)?.credential).toBe('new');
    const padded = run(edit, { type: 'SET_CREDENTIAL', value: '  new\t\n' });
    expect(connectionPatch(padded)?.credential).toBe('new');
    const blank = run(edit, { type: 'SET_CREDENTIAL', value: '  \n' });
    expect(connectionPatch(blank)).not.toHaveProperty('credential');
  });
});

describe('save and test', () => {
  it('creates the agent first, then tests it', async () => {
    const { api, ...mock } = fakeApi();
    const saved: Agent[] = [];
    await expect(saveAndTest(api, filled(), (a) => saved.push(a))).resolves.toEqual(PASSED);
    expect(mock.createAgent).toHaveBeenCalledWith(
      {
        name: 'Operator',
        protocol: 'cord-native',
        endpoint_url: 'wss://agent.example.com/cord',
        credential: 'sk-secret',
      },
      undefined,
    );
    expect(saved).toEqual([AGENT]);
    expect(mock.testAgent).toHaveBeenCalledWith(AGENT.id, undefined);
  });

  it('patches instead of creating a second agent on retry', async () => {
    const { api, ...mock } = fakeApi();
    const retry = run(
      filled(),
      { type: 'SAVED', agent: AGENT },
      { type: 'SET_ENDPOINT', value: 'wss://other.example.com/cord' },
    );
    await saveAndTest(api, retry, () => undefined);
    expect(mock.createAgent).not.toHaveBeenCalled();
    expect(mock.updateAgent).toHaveBeenCalledWith(
      AGENT.id,
      { name: 'Operator', protocol: 'cord-native', endpoint_url: 'wss://other.example.com/cord' },
      undefined,
    );
  });

  it('just re-tests when nothing changed', async () => {
    const { api, ...mock } = fakeApi();
    await saveAndTest(api, editWizard(AGENT), () => undefined);
    expect(mock.updateAgent).not.toHaveBeenCalled();
    expect(mock.testAgent).toHaveBeenCalledOnce();
  });

  it('keeps the saved agent when the test request fails', async () => {
    const { api, ...mock } = fakeApi();
    mock.testAgent.mockRejectedValueOnce(new Error('offline'));
    const saved: Agent[] = [];
    await expect(saveAndTest(api, filled(), (a) => saved.push(a))).rejects.toThrow('offline');
    expect(saved).toEqual([AGENT]);
  });
});

describe('onboarding', () => {
  it('shows only with no agents and not yet seen', () => {
    expect(shouldShowOnboarding(0, false)).toBe(true);
    expect(shouldShowOnboarding(0, true)).toBe(false);
    expect(shouldShowOnboarding(2, false)).toBe(false);
  });
});

describe('textEntryFor', () => {
  it('focuses a field and maps the return key on every text-entry step', () => {
    expect(textEntryFor('name')).toEqual({ returnKeyType: 'next' });
    expect(textEntryFor('endpoint')).toEqual({ returnKeyType: 'next' });
    expect(textEntryFor('credential')).toEqual({ returnKeyType: 'done' });
  });

  it('has no field on choice, test, voice, or ready steps', () => {
    for (const step of ['method', 'test', 'voice', 'ready'] as const) {
      expect(textEntryFor(step)).toBeUndefined();
    }
  });

  it('covers every text step of both create and edit flows', () => {
    const edit = editWizard(AGENT);
    const create = createWizard();
    const withField = [...CREATE_STEPS, ...EDIT_STEPS].filter((s) => textEntryFor(s) !== undefined);
    expect(new Set(withField)).toEqual(new Set(['name', 'endpoint', 'credential', 'model']));
    expect(textEntryFor(edit.step)).toBeUndefined(); // edit opens on the method choice
    expect(textEntryFor(create.step)).toEqual({ returnKeyType: 'next' });
  });
});
