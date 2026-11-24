import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  media: {},
  state: [] as unknown[],
  cursor: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: () => undefined,
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = initial;
      return [mocks.state[slot], () => undefined];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'a1', name: 'Home agent' }),
}));
vi.mock('@/api', () => ({ twringApi: () => undefined }));
vi.mock('@/components/chat/Attachments', () => ({ shareAttachment: vi.fn() }));
vi.mock('@/components/chat/ImageViewer', () => ({ ImageViewer: 'ImageViewer' }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/theme/fonts', () => ({ font: {} }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({}),
  space: { xs: 1, sm: 1, md: 1, lg: 1 },
  radius: { xs: 1 },
  type: new Proxy({}, { get: () => ({}) }),
}));
vi.mock('@/threads/files', () => ({ humanSize: (bytes: number) => `${bytes} B` }));
vi.mock('@/threads/media', () => ({ useMedia: () => mocks.media }));

import MediaScreen, { MEDIA_EMPTY_COPY, MEDIA_NOT_YET_COPY } from '../app/agents/[id]/media';

type Props = { label?: string; accessibilityLabel?: string; children?: ReactNode };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}
function render() {
  mocks.cursor = 0;
  return MediaScreen();
}
const labels = (tree: ReactElement) =>
  elements(tree).flatMap((e) =>
    [e.props.label, e.props.accessibilityLabel].filter((v): v is string => v !== undefined),
  );
const text = (tree: ReactElement) => JSON.stringify(tree);
const base = {
  status: 'ready',
  items: [],
  hasMore: false,
  refreshing: false,
  loadingMore: false,
  refresh: vi.fn(),
  loadMore: vi.fn(),
};

beforeEach(() => {
  mocks.state = [];
  mocks.media = { ...base };
});

describe('Photos and files screen', () => {
  it('shows a calm note when the server has no list yet', () => {
    mocks.media = { ...base, status: 'not_yet' };
    const tree = render();
    expect(text(tree)).toContain(MEDIA_NOT_YET_COPY);
    expect(elements(tree).some((e) => e.type === 'ErrorNotice')).toBe(false);
  });

  it('shows the empty state', () => {
    expect(text(render())).toContain(MEDIA_EMPTY_COPY);
  });

  it('shows an error with a retry', () => {
    mocks.media = { ...base, status: 'error', error: { message: 'Offline', retryable: true } };
    const notice = elements(render()).find((e) => e.type === 'ErrorNotice');
    expect(notice?.props).toMatchObject({ onRetry: base.refresh });
  });

  it('labels photos by who sent them and lists files with size and sender', () => {
    mocks.media = {
      ...base,
      hasMore: true,
      items: [
        {
          id: 'p1',
          name: 'a.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 5,
          direction: 'received',
          created_at: '2026-11-20T10:00:00.000Z',
        },
        {
          id: 'p2',
          name: 'b.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 5,
          direction: 'sent',
          created_at: '2026-11-20T10:00:00.000Z',
        },
        {
          id: 'd1',
          name: 'notes.pdf',
          mime_type: 'application/pdf',
          size_bytes: 42,
          direction: 'sent',
          created_at: '2026-11-20T10:00:00.000Z',
        },
      ],
    };
    const out = labels(render());
    expect(out.some((l) => l.startsWith('Photo from Home agent, '))).toBe(true);
    expect(out.some((l) => l.startsWith('Photo you sent, '))).toBe(true);
    expect(out.some((l) => l.startsWith('notes.pdf, 42 B · You sent'))).toBe(true);
    expect(out).toContain('Show older');
  });
});
