import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  COULDNT_OPEN,
  interruptedNotice,
  labelFor,
  PRIVATE_LABEL,
  PRIVATE_LABEL_EXCEPT,
  SERVER_READABLE_MARK,
  SPEECH_NOTE,
  VOICE_WARNING,
  sealedBubble,
} from './private-state';
import type { OpenedMessage } from './sealed-thread';

const at = '2026-11-25T10:00:00.000Z';
let n = 0;
const base = () => ({
  id: `msg_${String.fromCharCode(97 + (n++ % 26)).repeat(20)}`,
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  seq: n,
  rev: n,
  created_at: at,
  updated_at: at,
});
const sealedOk = () =>
  ({ ...base(), kind: 'sealed', author: 'agent', sealed: [] }) as unknown as ThreadMessage;
const voiceNote = () =>
  ({
    ...base(),
    kind: 'user_text',
    text: 'hi',
    status: 'sent',
    voice: { duration_s: 3 },
  }) as unknown as ThreadMessage;
const call = () =>
  ({
    ...base(),
    kind: 'call',
    call_id: 'c',
    duration_s: 5,
    outcome: 'completed',
  }) as unknown as ThreadMessage;

describe('the Private label (Task 24)', () => {
  it('shows the label only when every message is sealed', () => {
    expect(labelFor({ private: true, messages: [sealedOk(), sealedOk()] })!.text).toBe(
      'Private: only your phone and your computer can read this',
    );
    expect(labelFor({ private: true, messages: [sealedOk(), voiceNote()] })!.text).toBe(
      'Private, except messages marked as sent through Twring',
    );
    expect(labelFor({ private: false, messages: [sealedOk()] })).toBeUndefined();
  });

  it('never shows the label for an AI app agent', () => {
    expect(labelFor({ private: false, messages: [] })).toBeUndefined();
  });

  it('a call card does not take the label away; a plain message that slipped in does', () => {
    expect(labelFor({ private: true, messages: [sealedOk(), call()] })!.text).toBe(PRIVATE_LABEL);
    const plain = { ...voiceNote(), voice: undefined } as unknown as ThreadMessage;
    expect(labelFor({ private: true, messages: [plain] })!.text).toBe(PRIVATE_LABEL_EXCEPT);
  });

  it('copy is word for word and has no em dash', () => {
    expect(VOICE_WARNING).toBe(
      "Voice notes are turned into text on Twring's server, so this one won't be private. Send it anyway?",
    );
    expect(SPEECH_NOTE).toBe("Speech goes through Twring's server.");
    expect(COULDNT_OPEN).toBe("Couldn't open this message");
    for (const copy of [PRIVATE_LABEL, PRIVATE_LABEL_EXCEPT, SERVER_READABLE_MARK, VOICE_WARNING])
      expect(copy).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('sealed message bubbles', () => {
  const id = 'msg_' + 'q'.repeat(20);
  const message: ThreadMessage = { ...sealedOk(), id };
  const opened = (entry: OpenedMessage) => new Map([[id, entry]]);

  it('an opened message shows its text, quote and the reply, copy and share choices', () => {
    const bubble = sealedBubble(
      message,
      opened({
        id,
        author: 'agent',
        state: 'ok',
        text: 'hello',
        quote: { message_id: id, text: 'earlier', from: 'owner' },
      }),
      'Claude',
    );
    expect(bubble).toEqual({
      text: 'hello',
      own: false,
      opened: true,
      quote: { from: 'You', text: 'earlier' },
      actions: ['reply', 'copy', 'share'],
    });
  });

  it('a message that could not be opened says so and offers nothing to quote', () => {
    const bubble = sealedBubble(
      message,
      opened({ id, author: 'user', state: 'couldnt_open' }),
      'Claude',
    );
    expect(bubble).toEqual({ text: COULDNT_OPEN, own: false, opened: false, actions: [] });
  });

  it('shows the interrupted notice under an own private message', () => {
    const own = { ...message, author: 'user', status: 'interrupted' } as unknown as ThreadMessage;
    const entry = opened({ id, author: 'user', state: 'ok', text: 'do it' });
    const bubble = sealedBubble(own, entry, 'Claude Code')!;
    expect(interruptedNotice(own, bubble, 'Claude Code')).toEqual({
      text: 'Interrupted: Claude Code may have started this. Its answer will appear here if it finishes.',
      draft: 'do it',
    });
    // Not for a sent message, nor for the agent's own message.
    const sent = { ...own, status: 'sent' } as unknown as ThreadMessage;
    expect(interruptedNotice(sent, bubble, 'Claude Code')).toBeUndefined();
    const agent = sealedBubble(
      message,
      opened({ id, author: 'agent', state: 'ok', text: 'x' }),
      'C',
    )!;
    expect(interruptedNotice(own, agent, 'Claude Code')).toBeUndefined();
  });

  it('draws nothing while the keys are still loading', () => {
    expect(sealedBubble(message, undefined, 'Claude')).toBeUndefined();
  });

  it('draws no empty bubble for a reply stopped before the agent said anything', () => {
    for (const text of ['', ' \n '])
      expect(
        sealedBubble(message, opened({ id, author: 'agent', state: 'ok', text }), 'Claude'),
      ).toBeUndefined();
  });
});
