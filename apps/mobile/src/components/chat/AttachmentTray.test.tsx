import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/theme/fonts', () => ({ font: {} }));
vi.mock('@/theme/tokens', () => ({ usePalette: () => ({}) }));
vi.mock('@/threads/files', () => ({ humanSize: (n: number) => `${n} B` }));

const { AttachmentTray, REMOVE_HIT_SLOP } = await import('./AttachmentTray');

type El = ReactElement<{ children?: ReactNode; style?: unknown; [k: string]: unknown }>;

function findAll(node: ReactNode, type: string, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n: ReactNode) => findAll(n, type, out));
  else if (isValidElement(node)) {
    const el = node as El;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat)) as Record<string, unknown>;
  return (style as Record<string, unknown> | undefined) ?? {};
}

const file = {
  clientId: 'a',
  name: 'notes.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  uri: 'file://notes.pdf',
};

describe('AttachmentTray', () => {
  it('keeps the remove button inside its tile with a 44 px target', () => {
    const tree = AttachmentTray({ files: [file] as never, onRemove: () => {} });
    const [remove] = findAll(tree, 'Pressable');
    expect(remove?.props.accessibilityLabel).toBe('Remove notes.pdf');
    const style = flat(remove?.props.style);
    expect(style.top as number).toBeGreaterThanOrEqual(0);
    expect(style.right as number).toBeGreaterThanOrEqual(0);
    expect((style.width as number) + 2 * REMOVE_HIT_SLOP).toBeGreaterThanOrEqual(44);
  });

  it('uses the app icon, not a text glyph', () => {
    const tree = AttachmentTray({ files: [file] as never, onRemove: () => {} });
    expect(findAll(tree, 'Icon')).toHaveLength(1);
    const texts = findAll(tree, 'Text').map((t) => JSON.stringify(t.props.children));
    expect(texts.some((t) => /[×▤]/.test(t))).toBe(false);
  });
});
