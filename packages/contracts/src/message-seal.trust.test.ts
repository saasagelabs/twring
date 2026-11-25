import { describe, expect, it } from 'vitest';

import {
  base64urlEncode,
  deviceIdFor,
  e2eDeviceSchema,
  e2eDeviceWithNoteSchema,
  generateSealKeyPair,
  newMessageKey,
  openBody,
  openTrustNote,
  sealTrustNote,
  trustNoteAad,
  type TrustAddPayload,
} from './index';

const APPROVAL = `pap_${'c'.repeat(20)}`;

function device() {
  const pair = generateSealKeyPair();
  return { ...pair, id: deviceIdFor(pair.publicKey), key: base64urlEncode(pair.publicKey) };
}

describe('trust notes (C3 #11, Task 27)', () => {
  const t = device();
  const n = device();
  const c = device();
  const payload: TrustAddPayload = {
    kind: 'trust_add',
    approval_id: APPROVAL,
    add: { id: n.id, kind: 'phone', name: 'New phone', public_key: n.key },
    known: [{ id: c.id, kind: 'computer', name: 'Laptop', public_key: c.key }],
  };
  const note = sealTrustNote({
    payload,
    senderDevice: t.id,
    senderPrivate: t.privateKey,
    recipients: [
      { id: n.id, publicKey: n.publicKey },
      { id: c.id, publicKey: c.publicKey },
    ],
  });

  it('opens for each recipient with the sender key', () => {
    expect(openTrustNote(note, { deviceId: n.id, privateKey: n.privateKey }, t.publicKey)).toEqual(
      payload,
    );
    expect(
      openTrustNote(note, { deviceId: c.id, privateKey: c.privateKey }, t.publicKey).add.id,
    ).toBe(n.id);
  });

  it('refuses another sender key, a moved approval id or a flipped byte', () => {
    const me = { deviceId: c.id, privateKey: c.privateKey };
    expect(() => openTrustNote(note, me, device().publicKey)).toThrow();
    expect(() =>
      openTrustNote({ ...note, approval_id: `pap_${'d'.repeat(20)}` }, me, t.publicKey),
    ).toThrow();
    const flipped = `${note.body.slice(0, -2)}${note.body.endsWith('AA') ? 'BA' : 'AA'}`;
    expect(() => openTrustNote({ ...note, body: flipped }, me, t.publicKey)).toThrow();
  });

  it('is never opened as a chat message', () => {
    expect(() =>
      openBody(
        newMessageKey(),
        note.nonce,
        note.body,
        trustNoteAad({ approvalId: APPROVAL, senderDevice: t.id }),
      ),
    ).toThrow();
  });

  it('keeps the old device schema strict and adds the note only to the new one', () => {
    const row = {
      id: n.id,
      kind: 'phone',
      name: 'New phone',
      public_key: n.key,
      added_at: '2026-11-25T00:00:00.000Z',
    };
    expect(e2eDeviceSchema.safeParse({ ...row, trust_note: note }).success).toBe(false);
    expect(e2eDeviceWithNoteSchema.parse({ ...row, trust_note: note }).trust_note).toEqual(note);
  });
});
