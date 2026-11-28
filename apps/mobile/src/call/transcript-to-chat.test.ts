import type { CallState } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RingSettings } from '@/ring/protocol';

import {
  canOfferTranscript,
  createTranscriptToChat,
  transcriptSwitchOn,
  type TranscriptDeps,
} from './transcript-to-chat';

const ended: CallState = { status: 'ENDED', callId: 'call_1' };
const offer = {
  call: ended,
  connectedAt: 1_000,
  agentKnown: true,
  chatsAvailable: true,
  privateChat: false,
};
const OFF: RingSettings = { dnd: false, quiet_hours: null, call_transcripts: false };

function setup(overrides: Partial<TranscriptDeps> = {}, stored: RingSettings = OFF) {
  const update = vi.fn((settings: RingSettings) => Promise.resolve(settings));
  const sendTranscript = vi.fn(() => Promise.resolve('sent' as const));
  const deps: TranscriptDeps = {
    callId: 'call_1',
    ringSettings: () => Promise.resolve(stored),
    updateRingSettings: update,
    sendCallTranscript: sendTranscript,
    ...overrides,
  };
  const seen: string[] = [];
  const model = createTranscriptToChat(deps, () => seen.push(model.getState().kind));
  return { update, sendTranscript, model, seen };
}

describe('canOfferTranscript', () => {
  it('offers after a connected call to a chat that is not private', () => {
    expect(canOfferTranscript(offer)).toBe(true);
    const failed = {
      status: 'FAILED',
      callId: 'call_1',
      error: { code: 'GATEWAY_UNAVAILABLE', message: 'Lost', retryable: true },
    } as CallState;
    expect(canOfferTranscript({ ...offer, call: failed })).toBe(true);
  });

  it('hides for a private chat, no chats, no agent, or a call that never connected', () => {
    expect(canOfferTranscript({ ...offer, privateChat: true })).toBe(false);
    expect(canOfferTranscript({ ...offer, chatsAvailable: false })).toBe(false);
    expect(canOfferTranscript({ ...offer, agentKnown: false })).toBe(false);
    expect(canOfferTranscript({ ...offer, connectedAt: undefined })).toBe(false);
    expect(canOfferTranscript({ ...offer, call: { status: 'ENDED' } })).toBe(false);
  });
});

describe('createTranscriptToChat', () => {
  it('shows off, then saves on and sends this call', async () => {
    const { update, sendTranscript, model, seen } = setup();
    await model.load();
    expect(model.getState().kind).toBe('off');
    await model.setOn(true);
    expect(update).toHaveBeenCalledWith({ ...OFF, call_transcripts: true });
    expect(sendTranscript).toHaveBeenCalledWith('call_1');
    expect(seen).toEqual(['off', 'saving', 'sending', 'sent']);
    expect(transcriptSwitchOn(model.getState())).toBe(true);
  });

  it('says the words are gone on a 404, and hides on a private chat', async () => {
    const gone = setup({ sendCallTranscript: () => Promise.resolve('gone') });
    await gone.model.load();
    await gone.model.setOn(true);
    expect(gone.model.getState().kind).toBe('gone');
    const hidden = setup({ sendCallTranscript: () => Promise.resolve('private') });
    await hidden.model.load();
    await hidden.model.setOn(true);
    expect(hidden.model.getState().kind).toBe('private');
  });

  it('tries again while the server may still be closing the call, then sends', async () => {
    const answers = ['gone', 'gone', 'sent'] as const;
    let calls = 0;
    const waits: number[] = [];
    const { model } = setup({
      endedAt: 10_000,
      now: () => 12_000,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      sendCallTranscript: () => Promise.resolve(answers[calls++] ?? 'sent'),
    });
    await model.load();
    await model.setOn(true);
    expect(model.getState().kind).toBe('sent');
    expect(waits).toEqual([1500, 3000]);
  });

  it('says gone at once when the call ended long ago, and after the last try', async () => {
    const late = setup({
      endedAt: 0,
      now: () => 60_000,
      wait: () => Promise.reject(new Error('must not wait')),
      sendCallTranscript: () => Promise.resolve('gone'),
    });
    await late.model.load();
    await late.model.setOn(true);
    expect(late.model.getState().kind).toBe('gone');
    const send = vi.fn(() => Promise.resolve('gone' as const));
    const soon = setup({
      endedAt: 0,
      now: () => 1_000,
      wait: () => Promise.resolve(),
      sendCallTranscript: send,
    });
    await soon.model.load();
    await soon.model.setOn(true);
    expect(soon.model.getState().kind).toBe('gone');
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('puts the switch back when the save fails, and Retry saves again', async () => {
    const update = vi
      .fn<TranscriptDeps['updateRingSettings']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation((settings) => Promise.resolve(settings));
    const { sendTranscript, model } = setup({ updateRingSettings: update });
    await model.load();
    const turning = model.setOn(true);
    expect(transcriptSwitchOn(model.getState())).toBe(true);
    await turning;
    expect(model.getState().kind).toBe('save_failed');
    expect(transcriptSwitchOn(model.getState())).toBe(false);
    expect(sendTranscript).not.toHaveBeenCalled();
    await model.retry();
    expect(model.getState().kind).toBe('sent');
  });

  it('retries a failed send', async () => {
    const sendTranscript = vi
      .fn<TranscriptDeps['sendCallTranscript']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('sent');
    const { model } = setup({ sendCallTranscript: sendTranscript });
    await model.load();
    await model.setOn(true);
    expect(model.getState().kind).toBe('send_failed');
    await model.retry();
    expect(model.getState().kind).toBe('sent');
  });

  it('knows the transcript is already in the chat when the setting was on', async () => {
    const { update, sendTranscript, model } = setup({}, { ...OFF, call_transcripts: true });
    await model.load();
    expect(model.getState().kind).toBe('on_at_end');
    expect(transcriptSwitchOn(model.getState())).toBe(true);
    await model.setOn(false);
    expect(update).toHaveBeenCalledWith({ ...OFF, call_transcripts: false });
    expect(model.getState().kind).toBe('off');
    expect(sendTranscript).not.toHaveBeenCalled();
  });

  it('offers the switch when the settings cannot be read', async () => {
    const { model } = setup({ ringSettings: () => Promise.reject(new Error('offline')) });
    await model.load();
    expect(model.getState().kind).toBe('off');
  });
});
