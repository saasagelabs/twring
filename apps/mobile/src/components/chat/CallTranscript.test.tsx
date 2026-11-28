import type { CallTranscript } from '@twring/contracts';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text',
}));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('@/theme/fonts', () => ({ font: { interMedium: 'medium' } }));
vi.mock('@/theme/tokens', () => ({
  radius: new Proxy({}, { get: () => 0 }),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({
    surface: '#111',
    border: '#222',
    textPrimary: '#fff',
    textSecondary: '#aaa',
    textTertiary: '#888',
  }),
}));

import { CallTranscriptView, transcriptRows } from './CallTranscript';

const transcript: CallTranscript = {
  lines: [
    { who: 'you', text: 'Is the build green?' },
    { who: 'agent', text: 'It passed, but one test', cut: true },
    { who: 'you', text: 'Which one?' },
  ],
  truncated: true,
};

type Props = Record<string, unknown> & { children?: unknown };
function all(node: unknown, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) {
    for (const child of node) all(child, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const element = node as ReactElement<Props>;
  out.push(element);
  all(element.props.children, out);
  return out;
}
const render = (expanded: boolean, onToggle = vi.fn()) =>
  all(CallTranscriptView({ transcript, name: 'Hermes', expanded, onToggle }));
const labels = (nodes: ReactElement<Props>[]) =>
  nodes.flatMap((node) =>
    typeof node.props.accessibilityLabel === 'string' ? [node.props.accessibilityLabel] : [],
  );
const texts = (nodes: ReactElement<Props>[]) =>
  nodes.flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []));

describe('CallTranscript', () => {
  it('labels each line and marks an interrupted answer', () => {
    expect(
      transcriptRows(transcript, 'Hermes', true).map((row) => `${row.who}: ${row.text}`),
    ).toEqual([
      'You: Is the build green?',
      'Hermes: It passed, but one test (interrupted)',
      'You: Which one?',
    ]);
  });

  it('shows the first two lines collapsed, with Show transcript', () => {
    const onToggle = vi.fn();
    const nodes = render(false, onToggle);
    expect(labels(nodes)).toEqual([
      'You: Is the build green?',
      'Hermes: It passed, but one test (interrupted)',
    ]);
    expect(texts(nodes)).not.toContain('The rest of this call is not in the transcript.');
    const button = nodes.find((node) => node.type === 'TextButton');
    expect(button?.props.label).toBe('Show transcript');
    (button?.props.onPress as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows every line expanded, the truncated note, and Hide transcript', () => {
    const nodes = render(true);
    expect(labels(nodes)).toHaveLength(3);
    expect(texts(nodes)).toContain('The rest of this call is not in the transcript.');
    expect(nodes.find((node) => node.type === 'TextButton')?.props.label).toBe('Hide transcript');
  });

  it('offers no toggle when two lines are the whole call', () => {
    const short = { lines: transcript.lines.slice(0, 2) };
    const nodes = all(
      CallTranscriptView({ transcript: short, name: 'Hermes', expanded: false, onToggle: vi.fn() }),
    );
    expect(nodes.find((node) => node.type === 'TextButton')).toBeUndefined();
  });
});
