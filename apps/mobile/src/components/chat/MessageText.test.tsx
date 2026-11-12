import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
}));
vi.mock('@/theme/fonts', () => ({
  font: { body: 'body', bodyEmphasis: 'bodyEmphasis', mono: 'mono' },
}));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ accent: '#0ff', textPrimary: '#fff' }),
}));
vi.mock('@/threads/presentation', () => import('../../threads/presentation'));

import { MessageText } from './MessageText';

type Props = { children?: ReactNode; style?: Record<string, unknown>; [key: string]: unknown };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

// Shape of the Hermes approval prompt seen on 2026-11-11: about 850 chars, a long
// multi-line shell command inside ``` fences.
const command = [
  `cd /home/hermes/projects/twring && git fetch origin && git checkout -B fix/${'x'.repeat(120)}`,
  `pnpm --filter @twring/gateway exec node scripts/migrate.js --from=${'0'.repeat(200)}`,
  `curl -fsS https://example.com/api/v1/hooks?token=${'a'.repeat(260)} | tee /tmp/out.log`,
].join('\n');
const prompt = `Hermes wants to run this command:\n\`\`\`bash\n${command}\n\`\`\`\nAllow it?`;

it('wraps a fenced code block instead of laying it out on one unbounded line', () => {
  const all = elements(MessageText({ text: prompt, onLink: vi.fn() }));
  // A horizontal ScrollView lets the Text grow past Android's max texture size,
  // which draws nothing and leaves a blank bubble.
  expect(all.some((item) => item.type === 'ScrollView')).toBe(false);
  const code = all.find((item) => item.type === 'Text' && item.props.style?.fontFamily === 'mono');
  expect(code).toBeDefined();
  expect(code?.props.children).toBe(`${command}\n`);
  expect(code?.props.selectable).toBe(true);
  expect(code?.props.style).toMatchObject({ color: '#fff' });
  expect(code?.props.numberOfLines).toBeUndefined();
});

it('keeps prose around the code block readable', () => {
  const all = elements(MessageText({ text: prompt, onLink: vi.fn() }));
  const prose = all
    .filter((item) => item.type === 'Text' && typeof item.props.children === 'string')
    .map((item) => item.props.children);
  expect(prose).toContain('Hermes wants to run this command:\n');
  expect(prose).toContain('\nAllow it?');
});
