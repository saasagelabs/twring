import { describe, expect, it } from 'vitest';

import { agentEventSchema } from './agent';
import { attachmentSchema, MAX_FILE_BYTES, turnAttachmentSchema } from './files';
import { nativeUserTurnSchema } from './native-protocol';
import { connectorMessageRequestSchema } from './ring';
import { restTurnRequestSchema } from './rest-protocol';
import { sendMessageRequestSchema, threadMessageSchema } from './threads';

const fileId = 'fil_abcdefghijklmnopqrst';
const file = { id: fileId, name: 'photo.jpg', mime_type: 'image/jpeg', size_bytes: 1200 };
const at = '2026-10-14T10:00:00.000Z';
const common = {
  id: 'msg_abcdefghijklmnopqrst',
  agent_id: 'agt_abcdefghij0123456789',
  seq: 1,
  rev: 1,
  created_at: at,
  updated_at: at,
};
const userText = {
  ...common,
  kind: 'user_text',
  status: 'sent',
  client_id: '6f1f3c2e-8b1a-4c3d-9e2f-0a1b2c3d4e5f',
};
const agentText = { ...common, kind: 'agent_text', cut: false, partial: false };
const link = {
  ...file,
  url: 'https://api.twring.com/v1/files/fil_abcdefghijklmnopqrst?exp=1&sig=x',
  expires_at: at,
};
const event = { event_id: 'e1', turn_id: 't1' };

describe('attachments on messages', () => {
  it('accepts a photo without a caption, on either side', () => {
    expect(
      threadMessageSchema.safeParse({ ...userText, text: '', attachments: [file] }).success,
    ).toBe(true);
    expect(
      threadMessageSchema.safeParse({ ...agentText, text: '', attachments: [file] }).success,
    ).toBe(true);
  });

  it('still refuses a message with neither text nor files', () => {
    expect(threadMessageSchema.safeParse({ ...userText, text: '' }).success).toBe(false);
    expect(threadMessageSchema.safeParse({ ...agentText, text: '', attachments: [] }).success).toBe(
      false,
    );
  });

  it('keeps old messages valid and caps a message at 5 files', () => {
    expect(threadMessageSchema.safeParse({ ...userText, text: 'hi' }).success).toBe(true);
    const six = Array.from({ length: 6 }, () => file);
    expect(
      threadMessageSchema.safeParse({ ...userText, text: 'hi', attachments: six }).success,
    ).toBe(false);
  });

  it('refuses unknown types, empty files and anything over 10 MB', () => {
    expect(attachmentSchema.safeParse({ ...file, mime_type: 'application/zip' }).success).toBe(
      false,
    );
    expect(attachmentSchema.safeParse({ ...file, size_bytes: 0 }).success).toBe(false);
    expect(attachmentSchema.safeParse({ ...file, size_bytes: MAX_FILE_BYTES + 1 }).success).toBe(
      false,
    );
  });
});

describe('sending with files', () => {
  const clientId = userText.client_id;
  it('accepts files without text, and text without files', () => {
    expect(
      sendMessageRequestSchema.safeParse({
        client_id: clientId,
        text: '',
        attachment_ids: [fileId],
      }).success,
    ).toBe(true);
    expect(sendMessageRequestSchema.safeParse({ client_id: clientId, text: 'hi' }).success).toBe(
      true,
    );
  });

  it('refuses nothing at all, blank text alone, and repeated files', () => {
    expect(sendMessageRequestSchema.safeParse({ client_id: clientId, text: '   ' }).success).toBe(
      false,
    );
    expect(
      sendMessageRequestSchema.safeParse({
        client_id: clientId,
        text: 'hi',
        attachment_ids: [fileId, fileId],
      }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ client_id: clientId, text: 'hi', attachment_ids: [] })
        .success,
    ).toBe(false);
  });
});

describe('files to and from agents', () => {
  it('carries signed links on cord-agent and cord-rest turns, and old turns still parse', () => {
    const turn = {
      type: 'user.turn',
      session_id: 's',
      turn_id: 't',
      text: '',
      surface: 'text',
      started_at: at,
      committed_at: at,
    };
    expect(nativeUserTurnSchema.safeParse({ ...turn, attachments: [link] }).success).toBe(true);
    expect(nativeUserTurnSchema.safeParse(turn).success).toBe(true);
    expect(
      restTurnRequestSchema.safeParse({
        session_id: 's',
        turn_id: 't',
        text: '',
        surface: 'text',
        started_at: at,
        committed_at: at,
        protocol: 'cord-rest/1',
        call_id: 'c',
        attachments: [link],
      }).success,
    ).toBe(true);
    expect(turnAttachmentSchema.safeParse({ ...link, url: 'ftp://example.com/x' }).success).toBe(
      false,
    );
  });

  it('takes a file event with exactly one of an https url or a file id', () => {
    const base = { ...event, type: 'file', name: 'chart.png', mime_type: 'image/png' };
    expect(
      agentEventSchema.safeParse({ ...base, url: 'https://agent.example/chart.png' }).success,
    ).toBe(true);
    expect(agentEventSchema.safeParse({ ...base, file_id: fileId }).success).toBe(true);
    expect(agentEventSchema.safeParse(base).success).toBe(false);
    expect(
      agentEventSchema.safeParse({ ...base, url: 'https://agent.example/a.png', file_id: fileId })
        .success,
    ).toBe(false);
    expect(agentEventSchema.safeParse({ ...base, url: 'http://agent.example/a.png' }).success).toBe(
      false,
    );
  });
});

describe('connector messages with files', () => {
  const base = { local_agent: 'claude-code', origin: 'agent' };
  it('accepts files without text, and still refuses an empty message', () => {
    expect(
      connectorMessageRequestSchema.safeParse({ ...base, text: '', file_ids: [fileId] }).success,
    ).toBe(true);
    expect(connectorMessageRequestSchema.safeParse({ ...base, text: ' ' }).success).toBe(false);
  });
  it('refuses repeated files and more than 5', () => {
    expect(
      connectorMessageRequestSchema.safeParse({ ...base, text: 'x', file_ids: [fileId, fileId] })
        .success,
    ).toBe(false);
    expect(
      connectorMessageRequestSchema.safeParse({
        ...base,
        text: 'x',
        file_ids: Array.from({ length: 6 }, (_, n) => `fil_${'a'.repeat(19)}${'bcdefg'[n]}`),
      }).success,
    ).toBe(false);
  });
});
