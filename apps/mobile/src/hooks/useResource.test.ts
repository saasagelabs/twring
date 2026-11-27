import { beforeEach, describe, expect, it, vi } from 'vitest';

const react = vi.hoisted(() => ({
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  focus: undefined as (() => () => void) | undefined,
}));

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => {
    const slot = react.refCursor++;
    react.refs[slot] ??= { current: initial };
    return react.refs[slot];
  },
  useState: (initial: unknown) => {
    const slot = react.cursor++;
    if (!(slot in react.state)) react.state[slot] = initial;
    return [react.state[slot], (next: unknown) => (react.state[slot] = next)];
  },
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => () => void) => {
    react.focus = effect;
  },
}));
vi.mock('@/api/errors', () => ({ apiErrorCopy: () => ({ title: 'No connection' }) }));

import { type ResourceCache, useResource } from './useResource';

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function render<T>(load: (signal: AbortSignal) => Promise<T>, cache?: ResourceCache<T>) {
  return () => {
    react.cursor = 0;
    react.refCursor = 0;
    return useResource(load, cache ? { cache } : {});
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  react.state = [];
  react.refs = [];
  react.focus = undefined;
});

describe('useResource with a saved copy', () => {
  it('shows the saved copy when the load fails, then the fresh result', async () => {
    const save = vi.fn();
    const cache = { load: () => Promise.resolve(['saved']), save };
    let fail = true;
    const view = render(
      () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(['fresh'])),
      cache,
    );
    view();
    react.focus!();
    await settle();
    expect(view()).toMatchObject({ data: ['saved'], stale: true, loading: false });
    expect(view().error).toBeDefined();
    expect(save).not.toHaveBeenCalled();
    fail = false;
    view().reload();
    await settle();
    expect(view()).toMatchObject({ data: ['fresh'], stale: false, error: undefined });
    expect(save).toHaveBeenCalledWith(['fresh']);
  });

  it('a saved copy read after the fresh result never replaces it', async () => {
    const saved = deferred<string[] | undefined>();
    const view = render(() => Promise.resolve(['fresh']), {
      load: () => saved.promise,
      save: () => undefined,
    });
    view();
    react.focus!();
    await settle();
    saved.resolve(['saved']);
    await settle();
    expect(view()).toMatchObject({ data: ['fresh'], stale: false });
  });

  it('with no saved copy, a failed load shows nothing and the error', async () => {
    const view = render(() => Promise.reject(new Error('offline')), {
      load: () => Promise.resolve(undefined),
      save: () => undefined,
    });
    view();
    react.focus!();
    await settle();
    expect(view()).toMatchObject({ data: undefined, stale: false });
    expect(view().error).toBeDefined();
  });
});
