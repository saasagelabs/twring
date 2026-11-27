import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
}));
vi.mock('@/theme/fonts', () => ({ font: { body: 'body', bodyEmphasis: 'bodyEmphasis' } }));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({ accent: '#0ff', textSecondary: '#aaa', textPrimary: '#fff' }),
}));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/e2e/private-state', () => import('./private-state'));

import { PrivateBanner, VoiceConsentCard, VoiceNoteWarning } from '../components/chat/PrivateChat';
import { sealedBubble } from './private-state';

type Props = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const texts = (all: ReactElement<Props>[]) =>
  all.filter((item) => item.type === 'Text').map((item) => item.props.children);

describe('private chat screen pieces (Task 24)', () => {
  it('the banner shows the label and the speech note, read as one line', () => {
    const all = elements(
      PrivateBanner({ label: 'Private: only your phone and your computer can read this' }),
    );
    expect(texts(all)).toEqual([
      'Private: only your phone and your computer can read this',
      "Speech goes through Twring's server.",
    ]);
    expect(all[0]?.props.accessible).toBe(true);
    expect(all[0]?.props.accessibilityLabel).toBe(
      "Private: only your phone and your computer can read this. Speech goes through Twring's server.",
    );
  });

  it('asks before sending a voice note in a private chat', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const all = elements(VoiceNoteWarning({ onSend, onCancel }));
    expect(texts(all)).toContainEqual(expect.stringMatching(/won't be private/));
    const live = all.find((item) => item.props.accessibilityLiveRegion === 'polite');
    expect(live).toBeDefined();
    const send = all.find((item) => item.type === 'PrimaryButton');
    const cancel = all.find((item) => item.type === 'GhostButton');
    expect(send?.props.label).toBe('Send anyway');
    expect(cancel?.props.label).toBe("Don't send");
    (send?.props.onPress as () => void)();
    (cancel?.props.onPress as () => void)();
    expect(onSend).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('asks once before recording the first voice note in a private chat', () => {
    const onRecord = vi.fn();
    const onCancel = vi.fn();
    const all = elements(VoiceConsentCard({ onRecord, onCancel }));
    expect(texts(all)).toEqual([
      "Voice notes are turned into text on Twring's server, so they won't be private. Use voice notes in this chat?",
    ]);
    expect(all.find((item) => item.props.accessibilityLiveRegion === 'polite')).toBeDefined();
    const record = all.find((item) => item.type === 'PrimaryButton');
    const cancel = all.find((item) => item.type === 'GhostButton');
    expect(record?.props.label).toBe('Record');
    expect(cancel?.props.label).toBe('Not now');
    (record?.props.onPress as () => void)();
    (cancel?.props.onPress as () => void)();
    expect(onRecord).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a photo-only agent message is shown', () => {
    const id = 'msg_' + 'p'.repeat(20);
    const message = { id, kind: 'sealed', author: 'agent' } as unknown as Parameters<
      typeof sealedBubble
    >[0];
    const file = {
      file_id: 'fil_aaaaaaaaaaaaaaaaaaaa',
      key: 'k',
      name: 'a.jpg',
      mime: 'image/jpeg',
      size: 3,
    };
    const bubble = sealedBubble(
      message,
      new Map([[id, { id, author: 'agent', state: 'ok', text: '', files: [file] }]]),
      'Claude',
    );
    expect(bubble).toMatchObject({ text: '', own: false, opened: true, files: [file] });
    // Still nothing for a stopped reply with no text and no files.
    expect(
      sealedBubble(message, new Map([[id, { id, author: 'agent', state: 'ok', text: '' }]]), 'C'),
    ).toBeUndefined();
  });
});
