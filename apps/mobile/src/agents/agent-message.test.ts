import {
  connectorEndpointUrl,
  type Agent,
  type Connector,
  type LinkApproveResponse,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MESSAGE_COPY,
  agentSetupCommand,
  agentSetupMessage,
  alreadyAddedFor,
  connectorDownloadUrl,
  linkedFromConnector,
} from './agent-message';
import {
  createLinkWizard,
  linkCommand,
  linkReducer,
  pendingAgentRequests,
  pickLabel,
} from './link';

describe('a re-linked computer (ADR-027)', () => {
  const con = `con_${'a'.repeat(20)}`;
  const other = `con_${'b'.repeat(20)}`;
  const agent = (id: string, url: string, protocol = 'cord-connector') =>
    ({ id, name: id, protocol, endpoint_url: url }) as unknown as Agent;

  it('finds the agents of that computer already on the phone, once each', () => {
    const agents = [
      agent('agt_1', connectorEndpointUrl(con, 'hermes')),
      agent('agt_2', connectorEndpointUrl(con, 'hermes')),
      agent('agt_3', connectorEndpointUrl(other, 'codex')),
      agent('agt_4', 'https://agent.example.com/v1', 'cord-rest'),
    ];
    expect(alreadyAddedFor(agents, con)).toEqual(['hermes']);
    expect(alreadyAddedFor([], con)).toEqual([]);
  });

  it('shows them checked and locked, and only counts the new ones', () => {
    const linked = {
      connector_id: con,
      computer_name: 'VPS',
      agents: [
        { local_agent: 'hermes', kind: 'hermes', label: 'Hermes' },
        { local_agent: 'codex', kind: 'codex', label: 'Codex' },
      ],
    } as LinkApproveResponse;
    const state = linkReducer(createLinkWizard(), {
      type: 'APPROVED',
      linked,
      alreadyAdded: ['hermes', 'gone'],
    });
    expect(state.selected).toEqual(['hermes', 'codex']);
    expect(state.saved).toEqual(['hermes']);
    expect(pickLabel(state)).toBe('Add 1 agent');
    expect(pendingAgentRequests(state).map((r) => r.localAgent)).toEqual(['codex']);
    const all = linkReducer(createLinkWizard(), {
      type: 'APPROVED',
      linked,
      alreadyAdded: ['hermes', 'codex'],
    });
    expect(pickLabel(all)).toBe('Continue');
    expect(pendingAgentRequests(all)).toEqual([]);
  });
});

const SERVER = 'https://203-0-113-7.sslip.io';

describe('agent setup message', () => {
  it('builds the download URL from the API base URL, without a double slash', () => {
    expect(connectorDownloadUrl(SERVER)).toBe(`${SERVER}/downloads/twring-connect.mjs`);
    expect(connectorDownloadUrl(`${SERVER}//`)).toBe(`${SERVER}/downloads/twring-connect.mjs`);
    expect(connectorDownloadUrl('https://cord.example.com/api/')).toBe(
      'https://cord.example.com/api/downloads/twring-connect.mjs',
    );
  });

  it('puts the code in ABCD-EFGH form in the command', () => {
    const expected = `curl -fsSL ${SERVER}/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs setup --code ABCD-EFGH --server ${SERVER}`;
    expect(agentSetupCommand('ABCD-EFGH', SERVER)).toBe(expected);
    expect(agentSetupCommand('abcdefgh', SERVER)).toBe(expected);
    expect(agentSetupCommand('abcd–efgh', SERVER)).toBe(expected);
  });

  it('is the full message for the agent', () => {
    expect(agentSetupMessage('ABCD-EFGH', SERVER)).toBe(
      `Please connect yourself to my Twring app so I can talk to you by voice. On the machine you run on, run this, then tell me the last line it prints:

curl -fsSL ${SERVER}/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs setup --code ABCD-EFGH --server ${SERVER}

It needs Node.js 20 or newer; install it first if it's missing. On Windows PowerShell, use curl.exe instead of curl and run the two parts one after the other. The code works for 10 minutes.

Then read the Twring skill: how to talk on my calls, and to write down anything I ask for on a call so it gets done. Setup adds it for Claude Code, Codex and Hermes; any other agent can download it, unpack it into its skills folder and read SKILL.md: ${SERVER}/downloads/twring-skill.tar.gz`,
    );
  });

  it('on an own server, downloads from Twring and links to the own server', () => {
    const own = 'https://home.example.com';
    const message = agentSetupMessage('ABCD-EFGH', own, SERVER);
    expect(message).toContain(
      `curl -fsSL ${SERVER}/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs setup --code ABCD-EFGH --server ${own}`,
    );
    expect(message).toContain(`${SERVER}/downloads/twring-skill.tar.gz`);
    expect(message).not.toContain(`${own}/downloads`);
    expect(agentSetupMessage('ABCD-EFGH', SERVER, SERVER)).toBe(
      agentSetupMessage('ABCD-EFGH', SERVER),
    );
    expect(linkCommand(own, SERVER)).toBe(
      `curl -fsSL ${SERVER}/downloads/twring-connect.mjs -o twring-connect.mjs && node twring-connect.mjs --server ${own}`,
    );
  });

  it('keeps commands out of the words the owner reads', () => {
    for (const line of Object.values(AGENT_MESSAGE_COPY)) {
      expect(line).not.toMatch(/curl|node|npx|terminal|server|command|--/i);
    }
  });

  it('turns a claimed computer into the picker shape', () => {
    const connector: Connector = {
      id: `con_${'a'.repeat(20)}`,
      name: 'hermes-vps',
      online: true,
      created_at: '2026-10-06T10:00:00.000Z',
      agents: [{ id: 'hermes', label: 'Hermes', kind: 'acp' }],
    };
    expect(linkedFromConnector(connector)).toEqual({
      connector_id: connector.id,
      computer_name: 'hermes-vps',
      agents: [{ local_agent: 'hermes', kind: 'acp', label: 'Hermes' }],
    });
  });
});
