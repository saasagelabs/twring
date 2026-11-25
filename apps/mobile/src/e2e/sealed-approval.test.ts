import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  openControl,
  sealControl,
  unwrapKey,
  wrapKey,
  type SealedControlPayload,
  type SealedEnvelopeV1,
  type ThreadMessage,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { memoryStore } from './test-fixtures';
import type { TrustedDevice } from './pairing';
import {
  createPhoneContext,
  openMessage,
  sealOutgoingControl,
  type PhoneSealContext,
} from './sealed-thread';

/** Sealed approvals on the phone (C3 #11). */

const ACCOUNT = 'con_' + 'a'.repeat(20);
const AGENT = 'claude';
const phone = generateSealKeyPair();
const computer = generateSealKeyPair();
const stranger = generateSealKeyPair();
const PHONE_ID = deviceIdFor(phone.publicKey);
const COMPUTER_ID = deviceIdFor(computer.publicKey);
const APPROVAL_ID = `apv_${'k'.repeat(26)}`;

const trustedComputer: TrustedDevice = {
  id: COMPUTER_ID,
  kind: 'computer',
  name: 'Computer',
  public_key: base64urlEncode(computer.publicKey),
  verified_at: '2026-11-25T00:00:00.000Z',
};

function phoneCtx(): PhoneSealContext {
  let seq = 0;
  return createPhoneContext({
    accountId: ACCOUNT,
    agentId: AGENT,
    me: { deviceId: PHONE_ID, publicKey: phone.publicKey, privateKey: phone.privateKey },
    trusted: [trustedComputer],
    nextSeq: () => ++seq,
  });
}

function fromComputer(payload: SealedControlPayload, seq = 1, signer = computer.privateKey) {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: AGENT,
    senderDevice: COMPUTER_ID,
    senderSeq: seq,
  });
  const { nonce, body } = sealControl(key, payload, aad);
  const sealed: SealedEnvelopeV1 = {
    v: 1,
    sender_device: COMPUTER_ID,
    sender_seq: seq,
    nonce,
    body,
    keys: [
      { device: COMPUTER_ID, wrapped: wrapKey(key, signer, computer.publicKey, aad) },
      { device: PHONE_ID, wrapped: wrapKey(key, signer, phone.publicKey, aad) },
    ],
  };
  return {
    id: 'msg_' + 'b'.repeat(20),
    kind: 'sealed',
    author: 'agent',
    sealed: [sealed],
    approval: { state: 'pending', expires_at: '2026-11-25T10:10:00.000Z' },
    created_at: '2026-11-25T10:00:00.000Z',
  } as unknown as Extract<ThreadMessage, { kind: 'sealed' }>;
}

const request: SealedControlPayload = {
  kind: 'approval',
  approval_id: APPROVAL_ID,
  title: 'Use the key to deploy',
  description: 'Production',
  expires_at: '2026-11-25T10:10:00.000Z',
};

describe('sealed approvals on the phone', () => {
  it('opens an approval request from the trusted computer', () => {
    expect(openMessage(phoneCtx(), fromComputer(request))).toEqual({
      id: 'msg_' + 'b'.repeat(20),
      author: 'agent',
      state: 'approval',
      approvalId: APPROVAL_ID,
      title: 'Use the key to deploy',
      description: 'Production',
      expiresAt: '2026-11-25T10:10:00.000Z',
    });
  });

  it('shows a forged request as not opened', () => {
    const opened = openMessage(phoneCtx(), fromComputer(request, 1, stranger.privateKey));
    expect(opened.state).toBe('couldnt_open');
  });

  it('never shows a decision payload as an approval card', () => {
    const opened = openMessage(
      phoneCtx(),
      fromComputer({ kind: 'approval_decision', approval_id: APPROVAL_ID, decision: 'approve' }),
    );
    expect(opened.state).toBe('couldnt_open');
  });

  it('seals a decision the computer can open, with the next seq', () => {
    const ctx = phoneCtx();
    const decision: SealedControlPayload = {
      kind: 'approval_decision',
      approval_id: APPROVAL_ID,
      decision: 'deny',
    };
    const first = sealOutgoingControl(ctx, decision);
    const second = sealOutgoingControl(ctx, decision);
    expect(second.sender_seq).toBe(first.sender_seq + 1);
    const aad = messageAad({
      accountId: ACCOUNT,
      agentId: AGENT,
      senderDevice: PHONE_ID,
      senderSeq: first.sender_seq,
    });
    const mine = first.keys.find((k) => k.device === COMPUTER_ID)!;
    const key = unwrapKey(mine.wrapped, computer.privateKey, phone.publicKey, aad);
    expect(openControl(key, first.nonce, first.body, aad)).toEqual(decision);
    expect(JSON.stringify(first)).not.toContain('deny');
  });

  it('uses the keychain counter for a decision', async () => {
    const { PrivateChats } = await import('./private-chats');
    const store = memoryStore();
    const chats = new PrivateChats({
      store,
      replay: {
        load: () => Promise.resolve({}),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${AGENT}`),
    });
    const { confirmPairing } = await import('./pairing');
    await confirmPairing({ store }, trustedComputer);
    const a = await chats.sealDecision(AGENT, APPROVAL_ID, 'approve');
    const b = await chats.sealDecision(AGENT, APPROVAL_ID, 'approve');
    expect(b.sender_seq).toBeGreaterThan(a.sender_seq);
  });
});

describe('sealed approval sender (verify p148)', () => {
  it('an approval sealed by another trusted phone, not the computer, does not open as a card', () => {
    const other = generateSealKeyPair();
    const OTHER_ID = deviceIdFor(other.publicKey);
    let seq = 0;
    const ctx = createPhoneContext({
      accountId: ACCOUNT,
      agentId: AGENT,
      me: { deviceId: PHONE_ID, publicKey: phone.publicKey, privateKey: phone.privateKey },
      trusted: [
        trustedComputer,
        {
          id: OTHER_ID,
          kind: 'phone',
          name: 'Other phone',
          public_key: base64urlEncode(other.publicKey),
          verified_at: '2026-11-25T00:00:00.000Z',
        },
      ],
      nextSeq: () => ++seq,
    });
    const key = newMessageKey();
    const aad = messageAad({
      accountId: ACCOUNT,
      agentId: AGENT,
      senderDevice: OTHER_ID,
      senderSeq: 1,
    });
    const { nonce, body } = sealControl(key, request, aad);
    const m = {
      id: 'msg_' + 'c'.repeat(20),
      kind: 'sealed',
      author: 'agent',
      sealed: [
        {
          v: 1,
          sender_device: OTHER_ID,
          sender_seq: 1,
          nonce,
          body,
          keys: [
            { device: PHONE_ID, wrapped: wrapKey(key, other.privateKey, phone.publicKey, aad) },
          ],
        },
      ],
      created_at: '2026-11-25T10:00:00.000Z',
    } as unknown as Extract<ThreadMessage, { kind: 'sealed' }>;
    expect(openMessage(ctx, m).state).not.toBe('approval');
  });
});
