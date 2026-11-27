import { beforeEach, describe, expect, it, vi } from 'vitest';

const react = vi.hoisted(() => ({
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  focus: undefined as (() => () => void) | undefined,
  foreground: new Set<() => void>(),
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
vi.mock('./foreground', () => ({
  onForeground: (listener: () => void) => {
    react.foreground.add(listener);
    return () => react.foreground.delete(listener);
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
  react.foreground.clear();
});

describe('useResource with a saved copy', () => {
  it('shows the saved copy when the load fails, then the fresh result', async () => {
    const save = vi.fn();
    const cache = { load: () => Promise.resolve(['saved']), saver: () => save };
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
      saver: () => () => undefined,
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
      saver: () => () => undefined,
    });
    view();
    react.focus!();
    await settle();
    expect(view()).toMatchObject({ data: undefined, stale: false });
    expect(view().error).toBeDefined();
  });
});

describe('useResource on return to the app', () => {
  it('reloads quietly while focused, keeping the data, and not after blur', async () => {
    const load = vi.fn((_signal: AbortSignal) => Promise.resolve(load.mock.calls.length));
    const hook = render(load);
    hook();
    const blur = react.focus?.();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    react.foreground.forEach((listener) => listener());
    const during = hook();
    expect(during.loading).toBe(false);
    expect(during.data).toBe(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(hook().data).toBe(2);
    blur?.();
    expect(react.foreground.size).toBe(0);
  });
});
