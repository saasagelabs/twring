import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import type { ThreadMessage } from '@twring/contracts';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { OpenedMessage } from '../e2e/sealed-thread';

/**
 * The chat screen's wiring (C3 #11 P3c): an ordinary chat must look and behave as before, and a
 * private chat must show its label, hold a voice note for "Send anyway" and draw sealed bubbles.
 */
const mocks = vi.hoisted(() => {
  const chat: Record<string, unknown> & { sendVoice: Mock; send: Mock } = {
    sendVoice: vi.fn(),
    send: vi.fn(),
  };
  return { state: [] as unknown[], cursor: 0, deleted: [] as string[], chat };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (current: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = { current };
      return mocks.state[slot];
    },
    useEffect: () => undefined,
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state))
        mocks.state[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] =
            typeof next === 'function'
              ? (next as (v: unknown) => unknown)(mocks.state[slot])
              : next;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
  FlatList: 'FlatList',
  Share: { share: vi.fn() },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  KeyboardGestureArea: 'KeyboardGestureArea',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), back: vi.fn(), setParams: vi.fn() },
  useLocalSearchParams: () => ({ agentId: 'agt_a' }),
  useFocusEffect: () => undefined,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn(() => Promise.resolve()) }));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private uri: string) {}
    delete() {
      mocks.deleted.push(this.uri);
    }
  },
}));
vi.mock('@/agents/labels', () => ({
  agentStatusFor: () => ({ label: 'Online' }),
  callRefusal: () => undefined,
}));
vi.mock('@/agents/ai-app', () => ({
  aiAppEmptyChat: () => '',
  canCall: () => true,
  isAiApp: () => false,
  showComputerCallHint: () => false,
}));
vi.mock('@/threads/auto-listen', () => ({ autoListenTarget: () => undefined }));
vi.mock('@/api', () => ({ ApiError: class {}, twringApi: () => undefined }));
vi.mock('@/api/errors', () => ({
  apiErrorCopy: () => ({ message: 'This chat is private. Update Twring to send messages in it.' }),
}));
vi.mock('@/call/call-agent', () => ({ callAgent: vi.fn() }));
vi.mock('@/call/session', () => ({
  callController: () => undefined,
  useCallView: () => ({ call: undefined }),
}));
vi.mock('@/call/on-call', () => ({ useOnCall: () => ({ active: false }) }));
vi.mock('@twring/contracts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isActive: () => false,
}));
for (const [path, name] of [
  ['Avatar', 'Avatar'],
  ['ComputerCallHint', 'ComputerCallHint'],
  ['chat/Bubble', 'Bubble'],
  ['chat/ChatApproval', 'ChatApproval'],
  ['chat/CallCard', 'CallCard'],
  ['chat/Composer', 'Composer'],
  ['chat/DateSeparator', 'DateSeparator'],
  ['chat/LinkSheet', 'LinkSheet'],
  ['chat/Notice', 'Notice'],
  ['chat/SealedAttachments', 'SealedAttachments'],
  ['chat/StatusLine', 'StatusLine'],
  ['chat/WorkingRow', 'StreamingReply'],
  ['CallButton', 'CallButton'],
  ['OnCallChip', 'OnCallChip'],
  ['ErrorNotice', 'ErrorNotice'],
  ['GhostButton', 'GhostButton'],
  ['IconButton', 'IconButton'],
  ['Skeleton', 'Skeleton'],
] as const)
  vi.doMock(`@/components/${path}`, () => ({ [name]: name }));
vi.mock('@/components/chat/NewReplyPill', () => ({
  NewReplyPill: 'NewReplyPill',
  UnreadDivider: 'UnreadDivider',
}));
vi.mock('@/components/chat/MessageActions', () => ({
  MessageActionSheet: 'MessageActionSheet',
  ReplyBar: 'ReplyBar',
}));
vi.mock('@/components/chat/ListenButton', () => ({
  ListenButton: 'ListenButton',
  stopMessageSpeech: vi.fn(),
}));
vi.mock('@/components/chat/PrivateChat', () => ({
  PrivateBanner: 'PrivateBanner',
  VoiceNoteWarning: 'VoiceNoteWarning',
}));
vi.mock('@/components/chat/status-line', () => ({
  statusLineContent: () => undefined,
  latestOwn: () => undefined,
}));
vi.mock('@/e2e/private-state', () => import('../e2e/private-state'));
vi.mock('@/e2e/devices', () => import('../e2e/devices'));
vi.mock('@/hooks/useNow', () => ({ useNow: () => Date.parse('2026-11-25T12:00:00Z') }));
vi.mock('@/platform/ring', () => ({ ringPlatform: { clearMessages: vi.fn() } }));
vi.mock('@/hooks/useResource', () => ({
  STATUS_POLL_MS: 1,
  useResource: () => ({
    data: { id: 'agt_a', name: 'Hermes', messages: [] },
    loading: false,
    error: undefined,
    reload: () => undefined,
  }),
}));
vi.mock('@/theme/fonts', () => ({ font: {} }));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({}),
}));
vi.mock('@/threads/chats', () => ({
  chatController: () => undefined,
  useChat: () => mocks.chat,
  useDraft: () => ['', () => undefined],
}));
vi.mock('@/threads/scroll-state', () => ({
  firstUnreadSeq: () => undefined,
  initialPill: { show: false, count: 0 },
  nextPill: (p: unknown) => p,
  pillLabel: () => '',
  replyIds: () => [],
  shouldAnnounce: () => false,
}));
vi.mock('@/threads/presentation', async () => ({
  ...(await import('./presentation')),
  callDuration: () => '0:05',
  dateLabel: () => 'Today',
  messageStatus: () => '',
}));
vi.mock('@/threads/message-actions', () => import('./message-actions'));
vi.mock('@/threads/outbox', () => import('./outbox'));

let ChatScreen: () => ReactElement;
beforeAll(async () => {
  ChatScreen = (await import('../app/chats/[agentId]')).default;
});

type Props = Record<string, unknown> & { children?: ReactNode };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}
const at = '2026-11-25T10:00:00.000Z';
const base = { agent_id: 'agt_a', created_at: at, updated_at: at };
const userText = (id: string, seq: number, text: string): ThreadMessage =>
  ({
    ...base,
    id,
    seq,
    rev: seq,
    kind: 'user_text',
    text,
    status: 'answered',
  }) as unknown as ThreadMessage;
const agentText = (id: string, seq: number, text: string): ThreadMessage =>
  ({ ...base, id, seq, rev: seq, kind: 'agent_text', text }) as ThreadMessage;
const sealed = (id: string, seq: number, author: 'user' | 'agent'): ThreadMessage =>
  ({ ...base, id, seq, rev: seq, kind: 'sealed', author, sealed: [] }) as unknown as ThreadMessage;

function setChat(input: { private: boolean; messages: ThreadMessage[]; opened?: OpenedMessage[] }) {
  mocks.chat = {
    state: { messages: input.messages, maxRev: 0, progress: undefined },
    pending: [],
    private: input.private,
    opened: input.opened,
    pairAgain: false,
    privateNotice: undefined,
    filesAvailable: true,
    send: vi.fn(),
    sendFiles: vi.fn(),
    sendVoice: vi.fn(),
    retry: vi.fn(),
    discard: vi.fn(),
    stop: vi.fn(),
    loadOlder: vi.fn(),
    deleteMessage: vi.fn(),
    decideApproval: vi.fn(),
  };
}
function render() {
  mocks.cursor = 0;
  const all = elements(ChatScreen());
  const list = all.find((e) => e.type === 'FlatList');
  const rows = (list?.props.data ?? []) as { kind: string }[];
  const renderItem = list?.props.renderItem as (arg: { item: unknown }) => ReactNode;
  const items = rows.flatMap((item) => elements(renderItem({ item })));
  return { all, items };
}
const of = (all: ReactElement<Props>[], type: string) => all.filter((e) => e.type === type);
const composer = (all: ReactElement<Props>[]) =>
  of(all, 'Composer')[0].props as { onVoiceSend: (uri: string, ms: number) => void };

beforeEach(() => {
  mocks.state = [];
  mocks.deleted = [];
});

describe('an ordinary chat (flag on or off) is unchanged', () => {
  beforeEach(() =>
    setChat({
      private: false,
      messages: [userText('m1', 1, 'hello'), agentText('m2', 2, 'hi there')],
    }),
  );

  it('shows no Private banner and no "Sent through Twring" mark', () => {
    const { all, items } = render();
    expect(of(all, 'PrivateBanner')).toHaveLength(0);
    for (const bubble of of(items, 'Bubble')) expect(bubble.props.caption).toBeUndefined();
    expect(JSON.stringify(all)).not.toContain('Private');
  });

  it('renders the messages as before, with Listen on the agent reply', () => {
    const { items } = render();
    expect(of(items, 'Bubble').map((b) => [b.props.text, b.props.sender, b.props.muted])).toEqual([
      ['hi there', 'Hermes', undefined],
      ['hello', 'You', undefined],
    ]);
    expect(of(items, 'ListenButton').map((b) => b.props.messageId)).toEqual(['m2']);
  });

  it('sends a voice note at once, with no warning', () => {
    const first = render();
    composer(first.all).onVoiceSend('file:///v.m4a', 4000);
    expect(mocks.chat.sendVoice).toHaveBeenCalledWith('file:///v.m4a', 4000, undefined);
    expect(of(render().all, 'VoiceNoteWarning')).toHaveLength(0);
  });

  it('a reply still sends only the message id: the server builds the quote', () => {
    const { items } = render();
    const agentBubble = of(items, 'Bubble').find((b) => b.props.text === 'hi there')!;
    (agentBubble.props.onAction as (name: string) => void)('reply');
    const again = render();
    expect(of(again.all, 'ReplyBar')[0]?.props).toMatchObject({ text: 'hi there' });
    mocks.chat.send = vi.fn();
    // The draft is empty in this mock; send a voice note in reply instead, by id only.
    composer(again.all).onVoiceSend('file:///r.m4a', 1000);
    expect(mocks.chat.sendVoice).toHaveBeenCalledWith('file:///r.m4a', 1000, 'm2');
  });
});

describe('a private chat', () => {
  it('a key notice offers "Pair again", which opens pairing, never "Try again"', () => {
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    mocks.chat.privateNotice = 'Your computer was set up again, scan to continue';
    const notice = of(render().all, 'ErrorNotice')[0];
    expect(notice.props).toMatchObject({
      actionLabel: 'Pair again',
      error: { message: 'Your computer was set up again, scan to continue' },
    });
  });

  it('shows exactly the full label while every message is sealed', () => {
    setChat({
      private: true,
      messages: [sealed('s1', 1, 'user'), sealed('s2', 2, 'agent')],
      opened: [
        { id: 's1', author: 'user', state: 'ok', text: 'secret question' },
        { id: 's2', author: 'agent', state: 'couldnt_open' },
      ],
    });
    const { all, items } = render();
    expect(of(all, 'PrivateBanner').map((b) => b.props.label)).toEqual([
      'Private: only your phone and your computer can read this',
    ]);
    const bubbles = of(items, 'Bubble').map((b) => [b.props.text, b.props.muted, b.props.own]);
    expect(bubbles).toEqual([
      ["Couldn't open this message", true, false],
      ['secret question', false, true],
    ]);
    // No Listen on sealed bubbles (builder ruling).
    expect(of(items, 'ListenButton')).toHaveLength(0);
    // An unopenable message offers no actions.
    const muted = of(items, 'Bubble').find((b) => b.props.muted)!;
    expect(muted.props.actions).toEqual([]);
  });

  it('switches the label and marks a plain message when one is present', () => {
    setChat({
      private: true,
      messages: [userText('m1', 1, 'old plain'), sealed('s2', 2, 'agent')],
      opened: [{ id: 's2', author: 'agent', state: 'ok', text: 'opened' }],
    });
    const { all, items } = render();
    expect(of(all, 'PrivateBanner')[0]?.props.label).toBe(
      'Private, except messages marked as sent through Twring',
    );
    const plain = of(items, 'Bubble').find((b) => b.props.text === 'old plain')!;
    expect(plain.props.caption).toBe('Sent through Twring');
  });

  it("shows one quiet row per gap in the computer's messages, with the exact copy", () => {
    setChat({
      private: true,
      messages: [sealed('s1', 1, 'agent'), sealed('s5', 5, 'agent'), sealed('s9', 9, 'agent')],
      opened: [
        { id: 's1', author: 'agent', state: 'ok', text: 'one' },
        { id: 's5:gap', state: 'missing_before', missing: 3 },
        { id: 's5', author: 'agent', state: 'ok', text: 'five' },
        { id: 's9:gap', state: 'missing_before', missing: 1 },
        { id: 's9', author: 'agent', state: 'ok', text: 'nine' },
      ],
    });
    const { items } = render();
    const copy = 'A message from your computer is missing here.';
    expect(of(items, 'Notice').map((n) => n.props.text)).toEqual([copy, copy]);
    expect(items.filter((e) => e.props.accessibilityLabel === copy)).toHaveLength(2);
    // The row sits just before (above) the message that follows the gap.
    const order = items
      .filter((e) => e.type === 'Notice' || e.type === 'Bubble')
      .map((e) => (e.type === 'Notice' ? 'gap' : e.props.text));
    expect(order).toEqual(['gap', 'nine', 'gap', 'five', 'one']);
  });

  it('a reply stopped before the agent said anything draws no bubble but keeps its gap row', () => {
    setChat({
      private: true,
      messages: [sealed('s1', 1, 'agent'), sealed('s5', 5, 'agent')],
      opened: [
        { id: 's1', author: 'agent', state: 'ok', text: 'one' },
        { id: 's5:gap', state: 'missing_before', missing: 3 },
        { id: 's5', author: 'agent', state: 'ok', text: '' },
      ],
    });
    const { items } = render();
    expect(of(items, 'Bubble').map((b) => b.props.text)).toEqual(['one']);
    expect(of(items, 'Notice').map((n) => n.props.text)).toEqual([
      'A message from your computer is missing here.',
    ]);
  });

  it('shows the interrupted notice, with Ask again, under an own private message', () => {
    const own = { ...sealed('s1', 1, 'user'), status: 'interrupted' } as unknown as ThreadMessage;
    setChat({
      private: true,
      messages: [own],
      opened: [{ id: 's1', author: 'user', state: 'ok', text: 'do it' }],
    });
    const notices = of(render().items, 'Notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].props.text).toBe(
      'Interrupted: Hermes may have started this. Its answer will appear here if it finishes.',
    );
    expect(notices[0].props.action).toBe('Ask again');
    expect(typeof notices[0].props.onPress).toBe('function');
  });

  it('an interrupted private message that could not be opened has the notice but no action', () => {
    const own = { ...sealed('s1', 1, 'user'), status: 'interrupted' } as unknown as ThreadMessage;
    setChat({
      private: true,
      messages: [own],
      opened: [{ id: 's1', author: 'user', state: 'couldnt_open' }],
    });
    const notices = of(render().items, 'Notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].props.text).toMatch(/^Interrupted: Hermes may have started this/);
    expect(notices[0].props.action).toBeUndefined();
    expect(notices[0].props.onPress).toBeUndefined();
  });

  it("shows no gap row for the phone's own messages", () => {
    setChat({
      private: true,
      messages: [sealed('s1', 1, 'user'), sealed('s4', 4, 'user')],
      opened: [
        { id: 's1', author: 'user', state: 'ok', text: 'mine' },
        { id: 's4', author: 'user', state: 'ok', text: 'mine too' },
      ],
    });
    expect(of(render().items, 'Notice')).toHaveLength(0);
  });

  it('holds a voice note until "Send anyway"', () => {
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    composer(render().all).onVoiceSend('file:///v.m4a', 3000);
    expect(mocks.chat.sendVoice).not.toHaveBeenCalled();
    const warning = of(render().all, 'VoiceNoteWarning')[0];
    (warning.props.onSend as () => void)();
    expect(mocks.chat.sendVoice).toHaveBeenCalledWith('file:///v.m4a', 3000, undefined, {
      serverReadable: true,
    });
    expect(of(render().all, 'VoiceNoteWarning')).toHaveLength(0);
    expect(mocks.deleted).toEqual([]);
  });

  it('"Don\'t send" deletes the recording and sends nothing', () => {
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    composer(render().all).onVoiceSend('file:///v.m4a', 3000);
    const warning = of(render().all, 'VoiceNoteWarning')[0];
    (warning.props.onCancel as () => void)();
    expect(mocks.chat.sendVoice).not.toHaveBeenCalled();
    expect(mocks.deleted).toEqual(['file:///v.m4a']);
    expect(of(render().all, 'VoiceNoteWarning')).toHaveLength(0);
  });

  it('a second recording while one is held does not leak the first file', () => {
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    composer(render().all).onVoiceSend('file:///one.m4a', 3000);
    composer(render().all).onVoiceSend('file:///two.m4a', 3000);
    expect(mocks.deleted).toContain('file:///one.m4a');
  });
});

describe('a failed send', () => {
  const failedVoice = (clientId: string, createdAt: string) => ({
    clientId,
    agentId: 'agt_a',
    text: 'Voice note',
    state: 'failed' as const,
    createdAt,
    voice: { uri: 'file:///v.m4a', durationMs: 3000 },
    error: { code: 'private_thread' },
    errorCode: 'private_thread',
  });
  const texts = (items: ReactElement<Props>[]) =>
    of(items, 'Text').flatMap((t) => Children.toArray(t.props.children).map(String));

  it('a voice note refused as private shows the plain copy, not the server text', () => {
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    mocks.chat.pending = [
      failedVoice('c1', '2026-11-25T09:00:00.000Z'),
      { ...failedVoice('c2', '2026-11-25T11:00:00.000Z'), state: 'sending' },
    ];
    const shown = texts(render().items);
    expect(shown).toContain(
      "Didn't go through: this chat is private. Record the voice note again and tap Send anyway.",
    );
    expect(shown.join(' ')).not.toContain('Update Twring');
  });

  it('deletes a failed message from this phone after asking', async () => {
    const { Alert } = await import('react-native');
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    mocks.chat.pending = [failedVoice('c1', '2026-11-25T09:00:00.000Z')];
    const bubble = of(render().items, 'Bubble').find((b) => b.props.sender === 'You')!;
    (bubble.props.onAction as (name: string) => void)('delete');
    const alert = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    expect(alert[0]).toBe('Delete message?');
    const buttons = alert[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Delete')!.onPress!();
    expect(mocks.chat.discard).toHaveBeenCalledWith('c1');
  });

  it('a private_unsent item offers Delete, not Retry', async () => {
    const { Alert } = await import('react-native');
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    const unsent = (clientId: string, createdAt: string) => ({
      ...failedVoice(clientId, createdAt),
      voice: undefined,
      text: 'hello',
      error: undefined,
      errorCode: 'private_unsent',
    });
    mocks.chat.pending = [
      unsent('c1', '2026-11-25T09:00:00.000Z'),
      unsent('c2', '2026-11-25T11:00:00.000Z'),
    ];
    const { all, items } = render();
    const labels = (els: ReactElement<Props>[]) =>
      of(els, 'Pressable').map((p) => p.props.accessibilityLabel);
    // The older one is a row of its own; the newest sits in the status line.
    expect(labels(items)).toEqual(['Delete']);
    const row = of(items, 'Pressable')[0];
    (row.props.onPress as () => void)();
    const alert = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    (alert[2] as { text: string; onPress?: () => void }[]).find((b) => b.text === 'Delete')!
      .onPress!();
    expect(mocks.chat.discard).toHaveBeenCalledWith('c1');
    // The line's own content is built by statusLineContent (tested there); here its Delete.
    const line = of(all, 'StatusLine')[0];
    (line.props.onDelete as (id: string) => void)('c2');
    const second = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    (second[2] as { text: string; onPress?: () => void }[]).find((b) => b.text === 'Delete')!
      .onPress!();
    expect(mocks.chat.discard).toHaveBeenCalledWith('c2');
  });

  it('a lost recording offers Delete; a temporary failure offers Retry', async () => {
    const { Alert } = await import('react-native');
    setChat({ private: true, messages: [sealed('s1', 1, 'agent')], opened: [] });
    mocks.chat.pending = [
      {
        ...failedVoice('c1', '2026-11-25T09:00:00.000Z'),
        error: undefined,
        errorCode: 'voice_missing',
      },
      {
        ...failedVoice('c2', '2026-11-25T10:00:00.000Z'),
        error: undefined,
        errorCode: 'agent_offline',
      },
      { ...failedVoice('c3', '2026-11-25T11:00:00.000Z'), state: 'sending' },
    ];
    const { items } = render();
    const pressables = of(items, 'Pressable');
    // The list is drawn bottom-up: the newer failure comes first.
    expect(pressables.map((p) => p.props.accessibilityLabel)).toEqual(['Retry', 'Delete']);
    (pressables[1].props.onPress as () => void)();
    const alert = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    expect(alert[0]).toBe('Delete message?');
    (alert[2] as { text: string; onPress?: () => void }[]).find((b) => b.text === 'Delete')!
      .onPress!();
    expect(mocks.chat.discard).toHaveBeenCalledWith('c1');
    expect(texts(items)).toContain(
      "Didn't go through: this recording is no longer on your phone. Record it again.",
    );
  });

  it('keeps a failed message where it was sent; a sending one stays at the end', () => {
    setChat({
      private: false,
      messages: [userText('m1', 1, 'hello'), agentText('m2', 2, 'hi there')],
    });
    (mocks.chat.state as { messages: ThreadMessage[] }).messages = [
      { ...userText('m1', 1, 'hello'), created_at: '2026-11-25T09:00:00.000Z' },
      { ...agentText('m2', 2, 'hi there'), created_at: '2026-11-25T11:00:00.000Z' },
    ];
    mocks.chat.pending = [
      failedVoice('late', '2026-11-25T10:00:00.000Z'),
      { ...failedVoice('now', '2026-11-25T08:00:00.000Z'), state: 'sending' },
    ];
    const list = of(render().all, 'FlatList')[0];
    const keys = (list.props.data as { key: string; kind: string }[])
      .filter((row) => row.kind === 'message' || row.kind === 'pending')
      .map((row) => row.key)
      .reverse();
    expect(keys).toEqual(['m1', 'late', 'm2', 'now']);
  });
});
