import {
  agentEndpointUrlSchema,
  type Agent,
  type AgentProtocol,
  type ConnectionTestSummary,
  type UpdateAgentRequest,
} from '@twring/contracts';

import type { TwringApi } from '@/api/client';
import type { ErrorCopy } from '@/api/errors';

/**
 * The Connect Agent wizard (UX_UI_SPEC §6) as a pure reducer. Creating walks every step; editing a
 * saved agent's connection walks method → endpoint → credential → test. The agent is saved before
 * its connection test, so a failed test still leaves an editable agent behind.
 */
export type WizardStep =
  'name' | 'method' | 'endpoint' | 'credential' | 'model' | 'test' | 'voice' | 'ready';

export const CREATE_STEPS: readonly WizardStep[] = [
  'name',
  'method',
  'endpoint',
  'credential',
  'model',
  'test',
  'voice',
  'ready',
];
export const EDIT_STEPS: readonly WizardStep[] = [
  'method',
  'endpoint',
  'credential',
  'model',
  'test',
];

export type TestPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'finished'; result: ConnectionTestSummary }
  | { kind: 'error'; copy: ErrorCopy };

export interface WizardState {
  mode: 'create' | 'edit';
  step: WizardStep;
  /** Set once the agent exists on the server. */
  agentId?: string;
  name: string;
  protocol: AgentProtocol;
  endpoint: string;
  model: string;
  /** Typed this session only; cleared as soon as it is saved and never shown again. */
  credential: string;
  hasSavedCredential: boolean;
  removeCredential: boolean;
  voiceId?: string;
  test: TestPhase;
  /** Details changed since the last save, so the next test saves first. */
  dirty: boolean;
}

export type WizardAction =
  | { type: 'SET_NAME'; value: string }
  | { type: 'SET_PROTOCOL'; value: AgentProtocol }
  | { type: 'SET_ENDPOINT'; value: string }
  | { type: 'SET_MODEL'; value: string }
  | { type: 'SET_CREDENTIAL'; value: string }
  | { type: 'SET_REMOVE_CREDENTIAL'; value: boolean }
  | { type: 'SET_VOICE'; value: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'TEST_STARTED' }
  | { type: 'SAVED'; agent: Agent }
  | { type: 'TEST_FINISHED'; agent: Agent; result: ConnectionTestSummary }
  | { type: 'TEST_FAILED'; copy: ErrorCopy };

export function createWizard(): WizardState {
  return {
    mode: 'create',
    step: 'name',
    name: '',
    protocol: 'cord-native',
    endpoint: '',
    model: '',
    credential: '',
    hasSavedCredential: false,
    removeCredential: false,
    test: { kind: 'idle' },
    dirty: true,
  };
}

export function editWizard(agent: Agent): WizardState {
  return {
    mode: 'edit',
    step: 'method',
    agentId: agent.id,
    name: agent.name,
    protocol: agent.protocol,
    endpoint: agent.endpoint_url,
    model: agent.model ?? '',
    credential: '',
    hasSavedCredential: agent.has_credential,
    removeCredential: false,
    voiceId: agent.voice_id,
    test: { kind: 'idle' },
    dirty: false,
  };
}

export function stepsFor(state: WizardState): readonly WizardStep[] {
  const steps = state.mode === 'create' ? CREATE_STEPS : EDIT_STEPS;
  return state.protocol === 'openai-chat' ? steps : steps.filter((step) => step !== 'model');
}

export function isFirstStep(state: WizardState): boolean {
  return stepsFor(state)[0] === state.step;
}

export function isLastStep(state: WizardState): boolean {
  return stepsFor(state).at(-1) === state.step;
}

/** "Step 2 of 7" for the header and screen readers. */
export function stepPosition(state: WizardState): { index: number; total: number } {
  const steps = stepsFor(state);
  return { index: steps.indexOf(state.step) + 1, total: steps.length };
}

/**
 * How a text-entry step behaves: its field takes focus when the step appears, and the
 * keyboard's return key runs the step's primary action. Undefined for steps without a field.
 * The key step's return is "done" because it saves and starts the test.
 */
export function textEntryFor(step: WizardStep): { returnKeyType: 'next' | 'done' } | undefined {
  switch (step) {
    case 'name':
    case 'endpoint':
    case 'model':
      return { returnKeyType: 'next' };
    case 'credential':
      return { returnKeyType: 'done' };
    case 'method':
    case 'test':
    case 'voice':
    case 'ready':
      return undefined;
  }
}

export const ENDPOINT_EXAMPLES: Record<AgentProtocol, string> = {
  'cord-native': 'wss://agent.example.com/cord',
  'cord-rest': 'https://agent.example.com/cord/turns',
  'cord-connector': 'cord-connector://',
  'mcp-app': 'mcp-app://',
  'openai-chat': 'https://your-agent.example.com/v1',
};

/** Why the current step can't continue yet, in user words; undefined when it can. */
export function validateStep(state: WizardState): string | undefined {
  switch (state.step) {
    case 'name': {
      const name = state.name.trim();
      if (name === '') return 'Give your agent a name.';
      if (name.length > 60) return 'Use 60 characters or fewer.';
      return undefined;
    }
    case 'method':
      return undefined;
    case 'endpoint': {
      const url = state.endpoint.trim();
      if (url === '') return 'Enter the address of your agent.';
      const scheme = /^([a-z]+):\/\//i.exec(url)?.[1]?.toLowerCase();
      const secure = state.protocol === 'cord-native' ? 'wss' : 'https';
      const plain = state.protocol === 'cord-native' ? 'ws' : 'http';
      if (scheme !== secure && scheme !== plain) {
        return `This connection method needs an address that starts with ${secure}://, like ${ENDPOINT_EXAMPLES[state.protocol]}`;
      }
      if (!agentEndpointUrlSchema.safeParse(url).success) {
        return `That doesn't look like a full address. For example: ${ENDPOINT_EXAMPLES[state.protocol]}`;
      }
      return undefined;
    }
    case 'credential':
      return state.credential.length > 4096 ? 'That key is too long.' : undefined;
    case 'model':
      return state.model.trim().length > 200 ? 'Use 200 characters or fewer.' : undefined;
    case 'test':
      return state.test.kind === 'finished' && state.test.result.ok
        ? undefined
        : 'The connection test needs to pass first.';
    case 'voice':
      return state.voiceId === undefined ? 'Choose a voice.' : undefined;
    case 'ready':
      return undefined;
  }
}

function move(state: WizardState, delta: 1 | -1): WizardState {
  const steps = stepsFor(state);
  const next = steps[steps.indexOf(state.step) + delta];
  if (next === undefined) return state;
  return { ...state, step: next, ...(next === 'test' && { test: { kind: 'idle' } }) };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.value, dirty: true };
    case 'SET_PROTOCOL':
      return state.protocol === action.value
        ? state
        : { ...state, protocol: action.value, dirty: true };
    case 'SET_ENDPOINT':
      return { ...state, endpoint: action.value, dirty: true };
    case 'SET_MODEL':
      return { ...state, model: action.value, dirty: true };
    case 'SET_CREDENTIAL':
      return {
        ...state,
        credential: action.value,
        removeCredential: action.value === '' ? state.removeCredential : false,
        dirty: true,
      };
    case 'SET_REMOVE_CREDENTIAL':
      return {
        ...state,
        removeCredential: action.value,
        credential: action.value ? '' : state.credential,
        dirty: true,
      };
    case 'SET_VOICE':
      return { ...state, voiceId: action.value };
    case 'NEXT':
      return validateStep(state) === undefined ? move(state, 1) : state;
    case 'BACK':
      if (state.test.kind === 'running') return state;
      // Nothing to go back to once the agent is ready: the wizard is done.
      if (state.step === 'ready') return state;
      return move(state, -1);
    case 'TEST_STARTED':
      return state.step === 'test' ? { ...state, test: { kind: 'running' } } : state;
    case 'SAVED':
      return {
        ...state,
        agentId: action.agent.id,
        hasSavedCredential: action.agent.has_credential,
        credential: '',
        removeCredential: false,
        voiceId: state.voiceId ?? action.agent.voice_id,
        dirty: false,
      };
    case 'TEST_FINISHED':
      if (state.test.kind !== 'running') return state;
      return {
        ...state,
        hasSavedCredential: action.agent.has_credential,
        test: { kind: 'finished', result: action.result },
      };
    case 'TEST_FAILED':
      return state.test.kind === 'running'
        ? { ...state, test: { kind: 'error', copy: action.copy } }
        : state;
  }
}

/** The key as it will be sent: pasted keys often carry stray spaces or a trailing newline. */
function enteredCredential(state: WizardState): string {
  return state.credential.trim();
}

/** The PATCH for the edited connection details, or undefined when nothing needs saving. */
export function connectionPatch(state: WizardState): UpdateAgentRequest | undefined {
  if (!state.dirty) return undefined;
  return {
    ...(state.mode === 'create' && { name: state.name.trim() }),
    protocol: state.protocol,
    endpoint_url: state.endpoint.trim(),
    ...(state.protocol === 'openai-chat' && { model: state.model.trim() || null }),
    ...(enteredCredential(state) !== ''
      ? { credential: enteredCredential(state) }
      : state.removeCredential && { credential: null }),
  };
}

/**
 * Saves the agent (POST the first time, PATCH after) and runs its connection test. `onSaved` fires
 * as soon as the save lands so a retry after a failed test never creates a second agent.
 */
export async function saveAndTest(
  api: TwringApi,
  state: WizardState,
  onSaved: (agent: Agent) => void,
  signal?: AbortSignal,
): Promise<{ agent: Agent; result: ConnectionTestSummary }> {
  let agentId = state.agentId;
  if (agentId === undefined) {
    const agent = await api.createAgent(
      {
        name: state.name.trim(),
        protocol: state.protocol,
        endpoint_url: state.endpoint.trim(),
        ...(state.protocol === 'openai-chat' &&
          state.model.trim() !== '' && { model: state.model.trim() }),
        ...(state.voiceId !== undefined && { voice_id: state.voiceId }),
        ...(enteredCredential(state) !== '' && { credential: enteredCredential(state) }),
      },
      signal,
    );
    agentId = agent.id;
    onSaved(agent);
  } else {
    const patch = connectionPatch(state);
    if (patch !== undefined) onSaved(await api.updateAgent(agentId, patch, signal));
  }
  return api.testAgent(agentId, signal);
}
